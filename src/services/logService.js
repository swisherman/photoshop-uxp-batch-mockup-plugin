const  CONFIG  = require("../config.js");



async function logWorkflowEvent(payload) {
    const realpayload = {
        Description: payload,
        Created: new Date().toISOString()
    };

    try {
        await callCreateDocument(realpayload);
        return true;
    } catch (err) {
        // Fallback logging
        console.log(`[LOG FALLBACK]: ${payload}`);
        return true;
    }
}

async function callCreateDocument(payload) {
    try {
		 
        const response = await fetch(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.LOG}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();

        return data;
    } catch (err) {
        console.log(`Error in callCreateDocument: ${err.message}`);
        
        throw err;
    }
}



module.exports = {
    logWorkflowEvent
};