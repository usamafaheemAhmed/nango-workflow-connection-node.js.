// index.js
import express from "express";
import fetch from "node-fetch"; // install with: npm install express node-fetch
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";

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
  try {
    // ✅ Always encode formula to avoid spaces/quotes breaking the URL
    const formula = encodeURIComponent(`{Email}="${userEmail}"`);
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Users?filterByFormula=${formula}`;

    console.log("🔎 Airtable URL:", url);

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000, // ⏳ 20 seconds
    });

    console.log("---", JSON.stringify(res.data), "---");

    return res.data.records.length > 0 ? res.data.records[0] : null;
  } catch (err) {
    console.error(
      "❌ Failed to fetch user from Airtable:",
      err.response?.data || err.message
    );
    throw err;
  }
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
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Connecters`;

  try {
    const airtableRes = await axios.post(
      url,
      { records: [{ fields: recordFields }] },
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000, // ⏳ 20 seconds
      }
    );

    console.log("✅ Airtable response:", airtableRes.data);
    return airtableRes.data;
  } catch (err) {
    console.error(
      "❌ Failed to save connector:",
      err.response?.data || err.message
    );
    throw new Error(
      `Failed to save connector: ${JSON.stringify(
        err.response?.data || err.message
      )}`
    );
  }
}

// helper: fetch new contacts from Nango proxy
async function fetchNewContacts(
  connectionId,
  providerConfigKey,
  limit = 10,
  model
) {
  if (!connectionId || !providerConfigKey) {
    throw new Error("Missing connectionId or providerConfigKey");
  }

  const NANGO_SECRET_KEY_PROD = process.env.NANGO_SECRET_KEY_PROD;

  const res = await axios.get("https://api.nango.dev/records", {
    params: { model: model }, // query params
    headers: {
      "provider-config-key": providerConfigKey,
      "connection-id": connectionId,
      Authorization: `Bearer ${NANGO_SECRET_KEY_PROD}`,
      "Content-Type": "application/json",
    },
    timeout: 20000, // ⏳ 20 seconds
  });

  // Axios automatically throws on non-2xx, so no need for res.ok check
  const data = res.data;
  return Array.isArray(data.records) ? data.records : [];
}

// helper: save leads to Airtable
async function saveLeadsToAirtable(leads, providerConfigKey, connectionId) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return { success: false, message: "No leads to save" };
  }
  // 1. Find the Connecter record ID for this connectionId
  const connecterRes = await axios.get(
    `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Connecters`,
    {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      },
      timeout: 20000, // ⏳ 20 seconds
      params: {
        filterByFormula: `{Connection ID}="${connectionId}"`,
      },
    }
  );

  // No need for res.ok, axios throws on error automatically
  const connecterData = connecterRes.data;

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

    try {
      const res = await axios.post(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Leads`,
        { records },
        {
          headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          timeout: 20000, // ⏳ 20 seconds
        }
      );

      allResults.push(...res.data.records);
    } catch (err) {
      console.error(
        "❌ Airtable insert failed:",
        err.response?.data || err.message
      );
      throw new Error(
        `Airtable insert failed: ${JSON.stringify(
          err.response?.data || err.message
        )}`
      );
    }
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

  console.log("Lead to save:", lead);
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
  const record = buildRecord(Array.isArray(lead) ? lead[0] : lead);
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
        const res = await axios.post(
          "https://n8n.leadchaser.ai/webhook/287088cf-fd50-486e-b4f6-a2c299cf734b",
          {
            "Chaser ID": rec.id,
            "Lead Source": providerConfigKey,
            "Lead Name": leadName,
            "Lead Email": lead.email || "",
            "Lead Phone": lead.mobile_phone_number || lead.phone || "",
            "Lead ID": lead.id || "",
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 20000, // ⏳ 20 seconds
          }
        );

        console.log(`✅ Lead ${lead.id} sent to n8n`);
        return res.data;
      } catch (err) {
        console.error(
          `❌ Failed to send lead ${lead.id} to n8n:`,
          err.response?.data || err.message
        );
        return null;
      }
    })
  );
}
// check for dublications in AirTable
async function leadExistsInAirtable(leadId) {
  try {
    const res = await axios.get(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/Leads`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000, // ⏳ 20 seconds
        params: {
          filterByFormula: `{Source ID}="${leadId}"`,
        },
      }
    );
    return res.data.records.length > 0;
  } catch (err) {
    throw new Error(
      `Airtable lookup failed: ${err.response?.data || err.message}`
    );
  }
}
// ----------------- MAIN WEBHOOK -----------------
app.post("/webhook", async (req, res) => {
  try {
    console.log("🌍 ENV Check:");
    console.log(
      "NANGO_SECRET_KEY_PROD:",
      process.env.NANGO_SECRET_KEY_PROD ? "✅ Loaded" : "❌ Missing"
    );
    console.log(
      "AIRTABLE_API_TOKEN:",
      process.env.AIRTABLE_API_TOKEN ? "✅ Loaded" : "❌ Missing"
    );
    console.log(
      "AIRTABLE_BASE_ID:",
      process.env.AIRTABLE_BASE_ID ? "✅ Loaded" : "❌ Missing"
    );

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
    if (webhookData.type === "sync") {
      console.log("✅ Nango sync:", webhookData);

      if (
        webhookData.responseResults &&
        webhookData.responseResults.added > 0
      ) {
        const newContacts = await fetchNewContacts(
          webhookData.connectionId,
          webhookData.providerConfigKey,
          webhookData.responseResults.added,
          webhookData.model
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

    const NANGO_SECRET_KEY_PROD = process.env.NANGO_SECRET_KEY_PROD;

    const response = await fetch("https://api.nango.dev/connect/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NANGO_SECRET_KEY_PROD}`,
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
  console.log(process.env.NANGO_SECRET_KEY_PROD, "just to check correct key");
  try {
    const response = await fetch("https://api.nango.dev/integrations", {
      headers: {
        Authorization: `Bearer ${process.env.NANGO_SECRET_KEY_PROD}`,
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
