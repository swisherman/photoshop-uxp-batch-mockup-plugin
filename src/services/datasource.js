const fs = require("uxp").storage.localFileSystem;
const  CONFIG  = require("../config.js");


async function loadPhraseRecords(sourceType = "db") {
    if (sourceType === "db") {
        return await loadFromDB();
    }

    if (sourceType === "json") {
        return await loadFromJson();
    }

    throw new Error(`Unknown source type: ${sourceType}`);
}

async function loadFromDB() {
 const response = await fetch(
        `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.RECORDS_READY}`
    );
    if (!response.ok) {
        throw new Error(`db endpoint failed: ${response.status}`);
    }

    return await response.json();
}

async function loadFromJson() {
    const file = await fs.getFileForOpening({
        types: ["json"]
    });

    if (!file) {
        throw new Error("No JSON file selected");
    }

    const contents = await file.read();
    const data = JSON.parse(contents);

    return data.items || data;
}
async function loadPendingBatches() {
    const url =
        `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.BATCHES_PENDING}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Pending batches endpoint failed: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
        throw new Error(
            "Pending batches endpoint did not return an array."
        );
    }

    console.log(
        `Loaded ${data.length} pending batch record(s).`
    );

    return data;
}

async function loadBatchReadyRecords(batchId) {
    const url =
        `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.BATCH_READY(
            encodeURIComponent(batchId)
        )}`;

    const response = await fetch(url, {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            `Batch-ready endpoint failed: HTTP  ${response.status}`
        );
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
        throw new Error(
            "Batch-ready endpoint did not return an array."
        );
    }

    console.log(
        `Loaded ${data.length} batch-ready record(s).`
    );

    return data;
}

module.exports = {
    loadPhraseRecords,
    loadPendingBatches,
    loadBatchReadyRecords
};
