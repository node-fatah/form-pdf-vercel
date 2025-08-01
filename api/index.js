const express = require("express");
const serverless = require("serverless-http");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const path = require("path");
const axios = require("axios");
const { Readable } = require("stream");

const app = express();

app.use(bodyParser.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ],
});

const sheetsId = "1S8oHwZ839_cfFq1o1dK82HW9fCScntawCqX1zXPy15k";
const showSheetName = "Lembar";
const previousDataSheetName = "Dataset";
const driveFolderId = "1l8snVmCcBUiM1WzibJIZpeOi-pOTVeum";

let client;
let cachedRows = [];
let indexedDebitur = {};

async function getAuthClient() {
  if (!client) {
    client = await auth.getClient();
  }
  return client;
}

async function preloadData() {
  try {
    const client = await getAuthClient();
    const { data } = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: sheetsId,
      range: `${previousDataSheetName}!A2:AB`,
    });

    cachedRows = data.values || [];

    indexedDebitur = {};
    for (const row of cachedRows) {
      const name = row[2]?.trim();
      if (!name) continue;
      if (!indexedDebitur[name]) indexedDebitur[name] = [];
      indexedDebitur[name].push(row);
    }

    console.log("✅ Data Loaded and Indexed");
  } catch (error) {
    console.error("❌ Error loading data:", error);
  }
}

preloadData();
setInterval(preloadData, 60 * 60 * 1000);

app.get("/", async (req, res) => {
  if (req.query.forceReload === "true") {
    await preloadData();
  }

  if (!cachedRows.length) {
    return res.status(500).send("Please wait while data is loading...");
  }

  const debiturData = Array.from(
    new Set(
      cachedRows
        .filter((row) => row[0] !== "Heavy Equipment")
        .map((row) => row[2]?.trim())
        .filter(Boolean)
    )
  ).sort();

  res.render("form", { debitur: debiturData, angsuranKe: [] });
});

app.get("/getDebiturData", (req, res) => {
  try {
    const debiturName = req.query.name;
    if (!debiturName) {
      return res.status(400).json({ error: "Debitur name is required" });
    }

    const debiturRows = indexedDebitur[debiturName];
    if (!debiturRows?.length) {
      return res.status(404).json({ error: "Debitur not found" });
    }

    const lastRow = debiturRows[debiturRows.length - 1];
    const debiturStatus = lastRow[15];

    res.json({
      idAplikasi: lastRow[1],
      uidCollection: lastRow[10],
      overdueSekarang: lastRow[12],
      angsuran: lastRow[9],
      totalOverdue: lastRow[13],
      osPrincipal: lastRow[14],
      debiturStatus,
      angsuranKe: debiturRows.map((row) => row[8]).filter(Boolean),
    });
  } catch (error) {
    console.error("Error fetching Debitur data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/getDebiturTableData", (req, res) => {
  try {
    const debiturName = req.query.name;
    if (!debiturName) {
      return res.status(400).json({ error: "Debitur name is required" });
    }

    const selectedRows = indexedDebitur[debiturName];
    if (!selectedRows?.length) {
      return res.status(404).json({ error: "Debitur not found" });
    }

    const tableData = selectedRows.map((row) => [
      row[8],
      row[10],
      row[9],
      row[13],
      row[14],
      row[12] && !isNaN(row[12]) ? Number(row[12]) : 0,
      row[15],
    ]);

    res.json({ success: true, data: tableData });
  } catch (error) {
    console.error("Error fetching table data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/saveAndPrint", async (req, res) => {
  try {
    const {
      nomorSurat,
      printedDate,
      debitur,
      angsuranKe,
      idAplikasi,
      uidCollection,
      angsuran,
      totalOverdue,
      debiturStatus,
      type,
      peringatanLevel,
    } = req.body;

    if (!nomorSurat || !printedDate || !debitur) {
      return res.status(400).json({ error: "Nomor Surat, Printed Date, and Debitur are required" });
    }

    const client = await getAuthClient();

    const getRowCount = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: sheetsId,
      range: "Page!A2:A",
    });
    const rowNumber = (getRowCount.data.values?.length || 0) + 1;

    await sheets.spreadsheets.values.append({
      auth: client,
      spreadsheetId: sheetsId,
      range: `Page!A2`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          rowNumber,
          type,
          peringatanLevel,
          idAplikasi,
          debitur,
          angsuranKe,
          printedDate,
          nomorSurat,
          "Delivered"
        ]]
      }
    });

    const { data: as44Value } = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: sheetsId,
      range: `${showSheetName}!J66`,
    });

    const suffixText = as44Value.values?.[0]?.[0]
      ? `_${as44Value.values[0][0].toString().replace(/\s+/g, " ")}`
      : "";

    const now = new Date();
    const formattedDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate()
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}`;

    let range = "";
    let pdfFileName = "";

    if (type === "suratPeringatan") {
      range = "B1:J63";
      pdfFileName = `SP_${debitur}_${formattedDate}${suffixText}.pdf`;
    } else if (type === "customerCard") {
      range = "L1:X80";
      pdfFileName = `CC_${debitur}_${formattedDate}${suffixText}.pdf`;
    } else if (type === "reposition") {
      range = "AF1:AN60";
      pdfFileName = `REPO_${debitur}_${formattedDate}${suffixText}.pdf`;
    } else {
      return res.status(400).json({ error: "Invalid type selected" });
    }

    await sheets.spreadsheets.batchUpdate({
      auth: client,
      spreadsheetId: sheetsId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: await getSheetId(client, sheetsId, showSheetName),
                hidden: false,
              },
              fields: "hidden",
            },
          },
        ],
      },
    });

    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetsId}/export?` +
      new URLSearchParams({
        format: "pdf",
        size: "A4",
        portrait: true,
        fitw: true,
        top_margin: 0.5,
        right_margin: 0.7,
        bottom_margin: 0.5,
        left_margin: 0.7,
        sheetnames: false,
        printtitle: false,
        pagenumbers: false,
        gridlines: false,
        fzr: false,
        gid: await getSheetId(client, sheetsId, showSheetName),
        range: range,
      }).toString();

    const pdfRes = await axios.get(exportUrl, {
      headers: { Authorization: `Bearer ${await auth.getAccessToken()}` },
      responseType: "arraybuffer",
    });

    const pdfStream = Readable.from([Buffer.from(pdfRes.data)]);

    const drive = google.drive({ version: "v3", auth: client });
    const fileMetadata = {
      name: pdfFileName,
      parents: [driveFolderId],
    };
    const media = { mimeType: "application/pdf", body: pdfStream };
    const file = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id, webViewLink",
    });

    res.json({
      success: true,
      pdfUrl: `https://drive.google.com/file/d/${file.data.id}/view`,
    });

    await sheets.spreadsheets.batchUpdate({
      auth: client,
      spreadsheetId: sheetsId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: await getSheetId(client, sheetsId, showSheetName),
                hidden: true,
              },
              fields: "hidden",
            },
          },
        ],
      },
    });

  } catch (error) {
    console.error("Error saving and printing:", error);
    res.status(500).json({ error: "Error saving or printing SP" });
  }
});

async function getSheetId(authClient, spreadsheetId, sheetName) {
  const sheets = google.sheets({ version: "v4", auth: authClient });
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = response.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  return sheet ? sheet.properties.sheetId : null;
}

// 🚀 Export handler untuk vercel
module.exports = app;
module.exports.handler = serverless(app);
