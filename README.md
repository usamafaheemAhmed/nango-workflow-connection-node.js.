# Nango Integration Server

This project is an Express.js server that enables users to connect various tools via Nango, log authentication events and leads to Airtable, and forward leads to n8n for further processing. It serves a static UI for tool selection and manages integration sessions.

## Features

- **Tool Listing:** Fetches available integrations from Nango and displays them in a web UI.
- **Session Creation:** Initiates Nango connect sessions for selected tools.
- **Webhook Handling:** Receives Nango webhooks for authentication and sync events.
- **Airtable Logging:** Saves authentication events and new leads to Airtable.
- **Lead Forwarding:** Sends new leads to n8n via webhook.
- **Duplicate Prevention:** Checks for existing leads in Airtable before saving.

## Project Structure

```
.env
.gitignore
index.js
package.json
public/
  index.html
```

## Setup

1. **Install dependencies:**
   ```sh
   npm install
   ```

2. **Configure environment variables:**
   - Copy `.env` and fill in your Nango, Airtable, and other secrets.

3. **Start the server:**
   ```sh
   npm start
   ```
   The server runs on port `8080` by default.

## Endpoints

### `GET /tools`
Returns a list of available Nango integrations.

### `POST /create-session`
Creates a Nango connect session for a client and tool.

**Body:**
```json
{
  "clientId": "string",
  "toolKey": "string"
}
```

### `POST /webhook`
Handles Nango webhooks for authentication and sync events.

### Static UI

Visit [http://localhost:8080](http://localhost:8080) for the tool selection interface.

## Environment Variables

See `.env` for required variables:
- `NANGO_SECRET_KEY`
- `AIRTABLE_API_TOKEN`
- `AIRTABLE_BASE_ID`

## Dependencies

- express
- node-fetch
- dotenv
- morgan

## License

MIT

---

**Author:** Usama Faheem Ahmed