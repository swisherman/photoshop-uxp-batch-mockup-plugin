const { app } = require("photoshop");
const fs = require("uxp").storage.localFileSystem;
const CONFIG  = require("../config.js");

const url = `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.PSDS}`;

 class PhotoshopPSD 
 {
	constructor()
	{
	this.FilePathName="";
	this.Description="";
	
	this.PixelWidth =0;
	this.PixelHeight =0;
	this.Created= new Date().toISOString();
	}
	    
 }
class PhotoshopPSDCollection
{
    constructor() { }
	
    async GetRecordsReadyForMockupProcessing() {

  
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }


    // Parse JSON
    let data;

    try {
		data = await response.json();

    // Return only records NOT already processed
    return data.filter(item =>
        item.processingStatus !== "processed" &&
        item.mockupProcessed !== true
    );

   
    } catch (err) {
        console.log(`Error parsing JSON: ${err.message}`);
        throw new Error("Invalid JSON.");
    }
}

async GetAllRecords() {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}
}
	 
 
 
 module.exports = {
    PhotoshopPSD,
	PhotoshopPSDCollection
};