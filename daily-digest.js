#!/usr/bin/env node
/*
 * Daily SEC filings digest script
 *
 * This Node.js script fetches recent SEC filings for a set of stock tickers,
 * summarises the filings using the Anthropic API, and sends a digest email
 * via Gmail.  It uses the free EDGAR submissions API provided by the SEC to
 * fetch filing metadata and documents.  Filings are limited to the last 60
 * days and to the following forms: 8‑K, 10‑Q, 10‑K and DEF 14A.  The user
 * supplies API keys and account credentials via environment variables.
 *
 * Environment variables required:
 *   ANTHROPIC_API_KEY  – key for the Anthropic API (create on the Anthropic dashboard)
 *   GMAIL_USER         – your Gmail address (sender)
 *   GMAIL_APP_PASSWORD – an app password generated in your Google account
 *   RECIPIENT_EMAIL    – email address to receive the digest (default: same as GMAIL_USER)
 *   TICKERS            – comma‑separated list of stock tickers (e.g. "AAPL,MSFT,TSLA")
 *
 * Optional variables:
 *   DAYS               – number of days to look back for filings (default: 60)
 *
 * Usage: run with `node daily-digest.js`.  See the companion GitHub Actions
 * workflow for scheduling this script automatically in the cloud.
 */

const fetch = global.fetch || require('node-fetch');
const { Anthropic } = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');

// Number of days to look back for filings; defaults to 60 if not specified
const DAYS = parseInt(process.env.DAYS || '60', 10);
// Form types to include in the digest
const FORM_TYPES = ['8-K', '10-Q', '10-K', 'DEF 14A'];

/*
 * Fetch the mapping of tickers to CIK numbers from the SEC.  The SEC
 * publishes a JSON file mapping each publicly traded company's ticker
 * symbol to its Central Index Key (CIK).  Using this file avoids
 * dependence on commercial CIK lookup services.
 */
async function getTickerMap() {
  const url = 'https://www.sec.gov/files/company_tickers.json';
  const res = await fetch(url, {
    headers: {
      // Set a descriptive User-Agent header per SEC guidelines.  Use your email
      // or other contact so the SEC can reach you if necessary.
      'User-Agent': process.env.GMAIL_USER || 'digest-script@example.com',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to download ticker map: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const map = {};
  for (const key of Object.keys(data)) {
    const entry = data[key];
    // Normalise ticker to upper case for consistent lookups
    map[entry.ticker.toUpperCase()] = entry.cik_str;
  }
  return map;
}

// Pad a numeric CIK to 10 digits with leading zeros
function padCik(cik) {
  const str = typeof cik === 'string' ? cik : String(cik);
  return str.padStart(10, '0');
}

/*
 * Fetch recent filings for a company given its CIK.  Returns an array of
 * objects containing the form type, filing date, accession number, report
 * date and primary document name, filtered by date range and form type.
 */
async function getRecentFilings(cik) {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const paddedCik = padCik(cik);
  const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': process.env.GMAIL_USER || 'digest-script@example.com',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch submissions for CIK ${paddedCik}: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const { filings } = data;
  const results = [];
  if (!filings || !filings.recent) {
    return results;
  }
  const recent = filings.recent;
  const len = recent.filingDate.length;
  for (let i = 0; i < len; i++) {
    const formType = recent.form[i];
    if (!FORM_TYPES.includes(formType)) continue;
    const dateStr = recent.filingDate[i];
    const filingDate = new Date(dateStr);
    if (Number.isNaN(filingDate.getTime()) || filingDate < since) continue;
    results.push({
      form: formType,
      filingDate: dateStr,
      accessionNumber: recent.accessionNumber[i],
      primaryDoc: recent.primaryDocument[i],
      reportDate: recent.reportDate[i],
      cik,
    });
  }
  return results;
}

/*
 * Fetch the full text of a filing document.  The path is constructed
 * according to SEC conventions: /Archives/edgar/data/{CIK}/{accession}/{docName}.
 */
async function fetchFilingText(cik, accessionNumber, docName) {
  const accession = accessionNumber.replace(/-/g, '');
  const cikInt = parseInt(cik, 10);
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession}/${docName}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': process.env.GMAIL_USER || 'digest-script@example.com',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch filing document: ${url} – ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

/*
 * Summarise a filing using the Anthropic API.  To control costs and avoid
 * hitting token limits, the input text is truncated to the first 15 000
 * characters.  You can adjust this limit or refine the prompt as needed.
 */
async function summariseFiling(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_API_KEY environment variable.');
  }
  const client = new Anthropic({ apiKey });
  // Trim the text to a manageable length.  Anthropic models have input token
  // limits; long filings will be truncated to the first 15k characters.
  const input = text.slice(0, 15000);
  // Construct a single user message containing our summarisation instructions and the
  // truncated filing text.  The Messages API expects an array of messages where
  // each item has a role ("user" or "assistant") and a content string.
  const messages = [
    {
      role: 'user',
      content: `Please provide a concise professional summary of the following SEC filing focusing on material events, earnings changes, risk updates, executive changes and any other key points that investors should know.\n\n${input}`,
    },
  ];
  const response = await client.messages.create({
    model: 'claude-3-sonnet-20240229',
    messages,
    max_tokens: 400,
    temperature: 0.2,
  });
  // The response content is an array of message parts; concatenate any text parts.
  const completion = Array.isArray(response.content)
    ? response.content
        .filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('')
    : '';
  return completion.trim();
}

/*
 * Send the assembled digest email using nodemailer.  The message body is
 * provided in HTML; you can easily adapt this to send plain text by
 * changing the mail options.
 */
async function sendDigestEmail(subject, html) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set.');
  }
  const recipient = process.env.RECIPIENT_EMAIL || user;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: user,
    to: recipient,
    subject,
    html,
  });
}

/*
 * Main entrypoint.  Pulls tickers from the TICKERS environment variable,
 * fetches and summarises recent filings, and sends an email if there are
 * updates.  Errors are caught and logged to stderr.
 */
async function main() {
  const tickersEnv = process.env.TICKERS || '';
  const tickers = tickersEnv
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length === 0) {
    console.error('No tickers specified in TICKERS environment variable.');
    process.exit(1);
  }
  console.log(`Checking ${tickers.length} ticker(s): ${tickers.join(', ')}`);
  const tickerMap = await getTickerMap();
  let digestParts = [];
  for (const ticker of tickers) {
    const cik = tickerMap[ticker];
    if (!cik) {
      console.warn(`Warning: no CIK found for ticker ${ticker}; skipping.`);
      continue;
    }
    const filings = await getRecentFilings(cik);
    if (filings.length === 0) {
      console.log(`No recent filings for ${ticker} within the last ${DAYS} days.`);
      continue;
    }
    for (const filing of filings) {
      try {
        const fullText = await fetchFilingText(cik, filing.accessionNumber, filing.primaryDoc);
        const summary = await summariseFiling(fullText);
        digestParts.push(
          `<h3>${ticker} – ${filing.form} filed ${filing.filingDate}</h3>\n<p>${summary}</p>`
        );
      } catch (err) {
        console.error(`Error processing filing ${filing.accessionNumber} for ${ticker}:`, err);
      }
    }
  }
  if (digestParts.length === 0) {
    console.log('No qualifying filings found; digest email will not be sent.');
    return;
  }
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const subject = `SEC Filings Digest – ${today}`;
  const html = `<h2>SEC filings digest for ${today}</h2>\n${digestParts.join('\n')}\n<p style="font-size:smaller">This digest was generated automatically.\n Filings considered: ${FORM_TYPES.join(', ')} within the last ${DAYS} days.</p>`;
  await sendDigestEmail(subject, html);
  console.log('Digest email sent successfully.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
