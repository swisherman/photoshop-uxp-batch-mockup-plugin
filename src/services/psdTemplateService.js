const CONFIG = require("../config.js");

const url =
    `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.PSDS}`;

class PhotoshopPSD {
    constructor() {
        this.FilePathName = "";
        this.Description = "";
        this.ProductType = "";

        this.PixelWidth = 0;
        this.PixelHeight = 0;
        this.Created = new Date().toISOString();
    }
}

class PhotoshopPSDCollection {
    async GetRecordsReadyForMockupProcessing() {
        const response = await fetch(url);

        if (!response.ok) {
            const errorBody = await response.text();

            console.error(
                `PSD endpoint failed: HTTP ${response.status}`,
                errorBody
            );

            throw new Error(
                `PSD endpoint failed: HTTP ${response.status}: ${errorBody}`
            );
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            throw new Error(
                "PSD endpoint did not return an array."
            );
        }

        return data.filter(item =>
            String(item.processingStatus || "")
                .trim()
                .toLowerCase() !== "processed" &&
            item.mockupProcessed !== true
        );
    }

    async GetAllRecords() {
        const response = await fetch(url);

        if (!response.ok) {
            const errorBody = await response.text();

            console.error(
                `PSD endpoint failed: HTTP ${response.status}`,
                errorBody
            );

            throw new Error(
                `PSD endpoint failed: HTTP ${response.status}: ${errorBody}`
            );
        }

        const data = await response.json();

        if (!Array.isArray(data)) {
            throw new Error(
                "PSD endpoint did not return an array."
            );
        }

        return data;
    }
}

module.exports = {
    PhotoshopPSD,
    PhotoshopPSDCollection
};
