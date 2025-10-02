// index.js
import express from "express";
import fetch from "node-fetch"; // install with: npm install express node-fetch
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

import morgan from "morgan";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

app.use(morgan("combined")); // or "dev" for local debugging

// ----------------- NANGO WEBHOOK -----------------
// helper: fetch user from Airtable Users table
async function getUserFromAirtable(userEmail) {
  console.log(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Users?filterByFormula={Email}="${userEmail}"`
  );
  const res = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Users?filterByFormula={Email}="${userEmail}"`,
    {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch user from Airtable: ${text}`);
  }

  const data = await res.json();
  console.log("---", JSON.stringify(data), "---");
  return data.records.length > 0 ? data.records[0] : null;
}

// helper: save auth events to Airtable
async function saveAuthEventToAirtable(webhookData) {
  const connectionId = webhookData.connectionId || "";
  const provider = webhookData.provider || "";
  const clientId = webhookData.endUser?.endUserId || "";
  const clientName = webhookData.endUser?.display_name || "";
  const memberEmail = webhookData.endUser?.email || "";
  const success = webhookData.success === true ? "CONNECTED" : "FAILED";
  const environment = webhookData.environment || "";
  const operation = webhookData.operation || "";
  const providerConfigKey = webhookData.providerConfigKey || "";

  // 1. fetch user info
  let user = null;
  try {
    user = await getUserFromAirtable(memberEmail);
  } catch (err) {
    console.error("⚠️ Error fetching user:", err);
  }

  // 2. build new entry
  const recordFields = {
    "Connection ID": connectionId,
    Provider: provider,
    "Provider Config Key": providerConfigKey,
    "Client ID": clientId,
    Status: success,
    Environment: environment,
    Operation: operation,
    Created: new Date().toISOString().split("T")[0],
  };

  console.log("Saving auth event for user:", user);

  if (user) {
    recordFields.Name = user?.fields?.Name || "";
    recordFields.Chaser = Array.isArray(user.fields.Chaser)
      ? user.fields.Chaser
      : [];
    recordFields["Chaser ID"] = Array.isArray(user.fields["Chaser ID"])
      ? user.fields["Chaser ID"][0]
      : [];
    recordFields.User = [user.id] || ""; // assuming Name is user’s display name
    recordFields["User ID"] = user.id || clientId; // use Airtable recordId, not the Mspace ID
    recordFields.Leads = user.fields.Leads || "";
  }

  console.log("Saving auth event to Airtable with fields:", recordFields);

  // 3. save into Connecters table
  const airtableRes = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Connecters`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [{ fields: recordFields }],
      }),
    }
  );

  if (!airtableRes.ok) {
    const text = await airtableRes.text();
    throw new Error(`Failed to save connector: ${text}`);
  }

  return await airtableRes.json();
}

// helper: fetch new contacts from Nango proxy
async function fetchNewContacts(connectionId, providerConfigKey, limit = 10) {
  if (!connectionId || !providerConfigKey) {
    throw new Error("Missing connectionId or providerConfigKey");
  }

  const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;

  const res = await fetch(`https://api.nango.dev/records?model=Contact`, {
    method: "GET",
    headers: {
      "provider-config-key": providerConfigKey,
      "connection-id": connectionId,
      Authorization: `Bearer ${NANGO_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch contacts: ${text}`);
  }

  const data = await res.json();
  return Array.isArray(data.records) ? data.records : [];
}

// helper: save leads to Airtable
async function saveLeadsToAirtable(leads, providerConfigKey, connectionId) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return { success: false, message: "No leads to save" };
  }

  // 1. Find the Connecter record ID for this connectionId
  const connecterRes = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Connecters?filterByFormula={Connection ID}="${connectionId}"`,
    {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      },
    }
  );

  if (!connecterRes.ok) {
    const text = await connecterRes.text();
    throw new Error(`Failed to fetch Connecter: ${text}`);
  }

  const connecterData = await connecterRes.json();
  if (!connecterData.records || connecterData.records.length === 0) {
    throw new Error(`No Connecter found for Connection ID: ${connectionId}`);
  }

  const connecterRecordId = connecterData.records[0].id;

  // 2. Build Airtable record schema
  const buildRecord = (lead) => {
    const leadName =
      lead.first_name || lead.last_name
        ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
        : lead.email || "Unknown Lead";

    return {
      fields: {
        Status: lead.lead_status || "Connected",
        "Phone Type": lead.phone_type || "Mobile",
        "Lead Type": "MQL",
        "Lead Name": leadName,
        "Lead Email": lead.email || "",
        "Lead Phone": lead.mobile_phone_number || lead.phone || "",
        Source: providerConfigKey,
        "Source ID": lead.id || "",
        Connecters: [connecterRecordId], // ✅ Link lead to Connecter
      },
    };
  };

  // 3. Filter only unique (non-existing) leads
  const freshLeads = [];
  for (const lead of leads) {
    const exists = await leadExistsInAirtable(lead.id);
    if (!exists) freshLeads.push(lead);
  }

  if (freshLeads.length === 0) {
    return { success: true, message: "No new unique leads" };
  }

  // 4. Split into chunks of 10 (Airtable limit)
  const chunks = [];
  for (let i = 0; i < freshLeads.length; i += 10) {
    chunks.push(freshLeads.slice(i, i + 10));
  }

  const allResults = [];

  // 5. Save leads in batches
  for (const chunk of chunks) {
    const records = chunk.map(buildRecord);

    const res = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Leads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable insert failed: ${text}`);
    }

    const data = await res.json();
    allResults.push(...data.records);
  }

  return {
    success: true,
    stored: allResults.length,
    records: allResults,
  };
}

async function saveLeadToAirtable(lead, providerConfigKey) {
  if (!lead) {
    return { success: false, message: "No lead provided" };
  }

  console.log("Lead to save:", lead[0]);
  // return false
  // Map Nango lead → Airtable schema
  const buildRecord = (lead) => {
    const leadName =
      lead.first_name || lead.last_name
        ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
        : lead.email || "Unknown Lead";

    return {
      fields: {
        Status: lead.lead_status || "Connected",
        "Phone Type": lead.phone_type || "Mobile",
        "Lead Type": "MQL",
        "Lead Name": leadName,
        "Lead Email": lead.email || "",
        "Lead Phone": lead.mobile_phone_number || lead.phone || "",
        Source: providerConfigKey,
        // Connecters: ["Usama Faheem Ahmed"],
      },
    };
  };

  // Save to Airtable
  const record = buildRecord(lead[0]);
  const res = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Leads`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [record] }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable insert failed: ${text}`);
  }

  const data = await res.json();
  console.log("Airtable response:", data);
  return { success: true, record: data.records[0] };
}

// helper: forward leads to n8n
async function sendLeadsToN8N(leads, savedRecords, providerConfigKey) {
  return Promise.all(
    savedRecords.map(async (rec, i) => {
      const lead = leads[i];
      const leadName =
        lead.first_name || lead.last_name
          ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
          : lead.email || "Unknown Lead";

      try {
        const res = await fetch(
          "https://n8n.leadchaser.ai/webhook/287088cf-fd50-486e-b4f6-a2c299cf734b",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              "Chaser ID": rec.id,
              "Lead Source": providerConfigKey,
              "Lead Name": leadName,
              "Lead Email": lead.email || "",
              "Lead Phone": lead.mobile_phone_number || lead.phone || "",
              "Lead ID": lead.id || "",
            }),
          }
        );

        if (!res.ok) {
          const text = await res.text();
          console.error(`❌ Failed to send lead ${lead.id} to n8n: ${text}`);
        } else {
          console.log(`✅ Lead ${lead.id} sent to n8n`);
        }
      } catch (err) {
        console.error(`❌ Error sending lead ${lead.id} to n8n:`, err);
      }
    })
  );
}

// check for dublications in AirTable
async function leadExistsInAirtable(leadId) {
  const res = await fetch(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Leads?filterByFormula={Source ID}="${leadId}"`,
    {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable lookup failed: ${text}`);
  }

  const data = await res.json();
  return data.records.length > 0;
}

// ----------------- MAIN WEBHOOK -----------------
app.post("/webhook", async (req, res) => {
  try {
    const webhookData = req.body;
    // console.log("Nango webhook received:", webhookData);

    // Handle provider webhook
    if (webhookData.from === "nango" && webhookData.type === "webhook") {
      console.log("✅ Lead or provider data received:", webhookData.data);
      return res
        .status(200)
        .json({ success: true, message: "Lead data logged" });
    }

    // Handle sync events
    if (webhookData.type === "sync" && webhookData.model === "Contact") {
      console.log("✅ Nango sync:", webhookData);

      if (
        webhookData.responseResults &&
        webhookData.responseResults.added > 0
      ) {
        const newContacts = await fetchNewContacts(
          webhookData.connectionId,
          webhookData.providerConfigKey,
          webhookData.responseResults.added
        );

        if (newContacts.length > 0) {
          const airtableData = await saveLeadsToAirtable(
            newContacts,
            webhookData.providerConfigKey,
            webhookData.connectionId
          );

          const savedRecords = airtableData.records || [];
          await sendLeadsToN8N(
            newContacts,
            savedRecords,
            webhookData.providerConfigKey
          );

          return res.status(200).json({
            success: true,
            message: `Stored & forwarded ${savedRecords.length} new leads`,
          });
        }
      }

      return res
        .status(200)
        .json({ success: true, message: "No new contacts added" });
    }

    // Handle auth events
    if (
      webhookData.from !== "nango" ||
      webhookData.type !== "auth" ||
      webhookData.success !== true
    ) {
      return res.status(400).json({ error: "Invalid webhook type or source" });
    }

    // Save auth event in Airtable
    const data = await saveAuthEventToAirtable(webhookData);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("Error handling Nango webhook:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------- CREATE SESSION -----------------
app.post("/create-session", async (req, res) => {
  try {
    const { clientId, toolKey, clientName, memberEmail } = req.body;

    if (!clientId || !toolKey) {
      return res.status(400).json({ error: "Missing clientId or toolKey" });
    }

    const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;

    const response = await fetch("https://api.nango.dev/connect/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NANGO_SECRET_KEY}`,
      },
      body: JSON.stringify({
        end_user: {
          id: memberEmail,
          display_name: clientName,
          email: memberEmail,
        },
        allowed_integrations: [toolKey],
      }),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("Error in /create-session:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------- FETCH TOOLS -----------------
app.get("/tools", async (req, res) => {
  try {
    const response = await fetch("https://api.nango.dev/integrations", {
      headers: {
        Authorization: `Bearer ${process.env.NANGO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(raw);

    const data = JSON.parse(raw);

    const integrations = data.data.map((i) => ({
      key: i.unique_key,
      provider: i.provider,
      name: i.display_name || i.provider,
      logo: i.logo,
    }));

    return res.status(200).json(integrations);
  } catch (err) {
    console.error("Error fetching tools:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ----------------- Static UI for Testing -----------------
app.use(express.static(path.join(__dirname, "public")));

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
