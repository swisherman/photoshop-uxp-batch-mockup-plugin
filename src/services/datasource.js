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

module.exports = {
    loadPhraseRecords
};