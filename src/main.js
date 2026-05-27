const { PhotoshopPSDCollection } = require("./services/psdTemplateService.js");
const { loadPhraseRecords } = require("./services/datasource.js");


const { logWorkflowEvent } = require("./services/logService.js");
const { app, action, core } = require("photoshop");
const { entrypoints } = require("uxp");
const fs = require("uxp").storage.localFileSystem;


const MASCOT_LAYER_NAME = "mascot";
const PHRASE_SMART_OBJECT_NAME = "phrase";
const INNER_PHRASE_TEXT_LAYER_NAME = "phrase";






function getSelectedPsdSource() {
    const group = document.getElementById("psdSourceGroup");
    return group?.value || group?.selected || "db";
}

function getPsdRootFolderTokenKey() {
    const selectedSource = getSelectedPsdSource();

    return selectedSource === "json"
        ? "jsonPsdRootFolderToken"
        : "dbPsdRootFolderToken";
}

async function refreshPsdRootFolderStatus() {
    const tokenKey = getPsdRootFolderTokenKey();
    const folder = await getRememberedFolder(tokenKey, null, false);

    const el = document.getElementById("currentPSDRootFolder");
    if (el) {
        el.textContent = folder?.nativePath || "Not selected";
    }
}
function getSelectedPhraseSource() {
    const group = document.getElementById("phraseSourceGroup");
    return group?.value || group?.selected || "json";
}

function getFolderTokenKeysForSelectedSource() {
    const selectedSource = getSelectedPhraseSource();

    return {
        selectedSource,
        inputTokenKey: selectedSource === "json"
            ? "jsonInputFolderToken"
            : "dbInputFolderToken",

        outputTokenKey: selectedSource === "json"
            ? "jsonOutputFolderToken"
            : "dbOutputFolderToken"
    };
}

async function refreshFoldersForSelectedSource() {
    const { selectedSource, inputTokenKey, outputTokenKey } =
        getFolderTokenKeysForSelectedSource();

    let inputFolder = null;
    let outputFolder = null;

    try {
        inputFolder = await getRememberedFolder(inputTokenKey, null, false);
    } catch (err) {
        console.log(`No input folder for ${selectedSource}: ${err.message}`);
    }

    try {
        outputFolder = await getRememberedFolder(outputTokenKey, null, false);
    } catch (err) {
        console.log(`No output folder for ${selectedSource}: ${err.message}`);
    }

    updateFolderStatus(inputFolder, outputFolder);
}
function updateFolderStatus(inputFolder, outputFolder) {
    const inputEl = document.getElementById("currentInputFolder");
    const outputEl = document.getElementById("currentOutputFolder");

    if (inputEl) {
        inputEl.textContent = inputFolder?.nativePath || "Not selected";
    }

    if (outputEl) {
        outputEl.textContent = outputFolder?.nativePath || "Not selected";
    }
}

async function getRememberedFolder(tokenKey, promptText, allowPrompt = true) {
    let folderToken = localStorage.getItem(tokenKey);

    if (folderToken) {
        try {
            return await fs.getEntryForPersistentToken(folderToken);
        } catch (err) {
            console.log(`Invalid token for ${tokenKey}`);
        }
    }

    if (!allowPrompt) return null;

    const folder = await fs.getFolder();
    const newToken = await fs.createPersistentToken(folder);
    localStorage.setItem(tokenKey, newToken);

    return folder;
}


async function populatePSDDropdownFromRecords(records) {
    const menu = document.getElementById("psdMenu");

    if (!menu) {
        console.error("psdMenu not found");
        return;
    }

    menu.innerHTML = "";

    for (const product of records) {
        const item = document.createElement("sp-menu-item");
        item.value = product.FilePathName;
        item.textContent = product.Description || product.FilePathName;
        menu.appendChild(item);
    }

    const psdDropdown = document.getElementById("psdPicker");

    if (records.length > 0) {
        psdDropdown.value = records[0].FilePathName;
    }

    document.getElementById("openSelectedPSD").disabled = !psdDropdown.value;
}


async function populatePSDDropdownFromDB() {
    const psdCollection = new PhotoshopPSDCollection();
    const records = await psdCollection.GetRecordsReadyForMockupProcessing();

    await populatePSDDropdownFromRecords(records);
    // Enable only if something is actually available/selected
    const psdDropdown = document.getElementById("psdPicker");
    const openSelectedPsdButton = document.getElementById("openSelectedPSD");

    openSelectedPsdButton.disabled = !psdDropdown.value;
}

async function populatePSDDropdownFromJsonFile() {
    const jsonFile = await fs.getFileForOpening({ types: ["json"] });

    if (!jsonFile) {
        await app.showAlert("No PSD JSON file selected.");
        return;
    }

    const jsonText = await jsonFile.read();
    const records = JSON.parse(jsonText);

    if (!Array.isArray(records)) {
        await app.showAlert("PSD JSON file must contain an array.");
        return;
    }

    await populatePSDDropdownFromRecords(records);
}

async function openSelectedTemplatePSD(item) {
    const relativePath = item.value;

    const tokenKey = getPsdRootFolderTokenKey();

    const rootFolder = await getRememberedFolder(
        tokenKey,
        "Select PSD root folder"
    );

    if (!rootFolder) {
        await app.showAlert("PSD root folder not selected.");
        return;
    }

    const psdFile = await getFileFromRelativePath(rootFolder, relativePath);

    if (!psdFile) {
        await app.showAlert(`Could not find PSD:\n${relativePath}`);
        return;
    }

    await core.executeAsModal(
        async () => {
            await app.open(psdFile);
        },
        { commandName: "Open Document from Plugin" }
    );
}
function showPanel() {
    document.getElementById("mainPanelSection").classList.remove("hidden");
    document.getElementById("psdPanelSection").classList.remove("hidden");
}

async function renameLayer(layer, newName) {
    await action.batchPlay(
        [
            {
                _obj: "set",
                _target: [{ _ref: "layer", _id: layer.id }],
                to: {
                    _obj: "layer",
                    name: newName
                }
            }
        ],
        {
            synchronousExecution: true
        }
    );
}

async function setTextInsideSmartObject(smartObjectLayer, newText, innerTextLayerName = "phrase") {
    // Select the smart object layer
    await action.batchPlay(
        [
            {
                _obj: "select",
                _target: [{ _ref: "layer", _id: smartObjectLayer.id }],
                makeVisible: false
            }
        ],
        { synchronousExecution: true }
    );

    // Open smart object contents
    await action.batchPlay(
        [
            {
                _obj: "placedLayerEditContents"
            }
        ],
        { synchronousExecution: true }
    );

    // Now the active document is the smart object document
    const soDoc = app.activeDocument;
    if (!soDoc) {
        throw new Error("Could not access smart object document.");
    }

    const innerTextLayer = await findLayerByNameRecursive(soDoc.layers, innerTextLayerName);
    if (!innerTextLayer) {
        await logLayersRecursive(soDoc.layers);
        throw new Error(`Could not find inner text layer named ${innerTextLayerName} inside smart object.`);
    }

    await setTextLayerContents(innerTextLayer, newText);

    // Save smart object contents
    await action.batchPlay(
        [
            {
                _obj: "save"
            }
        ],
        { synchronousExecution: true }
    );

    // Close smart object document
    await action.batchPlay(
        [
            {
                _obj: "close",
                saving: {
                    _enum: "yesNo",
                    _value: "yes"
                }
            }
        ],
        { synchronousExecution: true }
    );
}

async function applyPhraseAndMascot(phrase, designFile) {
    const doc = app.activeDocument;
    if (!doc) {
        throw new Error("No active Photoshop document.");
    }

    await logLayersRecursive(doc.layers);

    const mascotLayer = await findLayerByNameRecursive(doc.layers, MASCOT_LAYER_NAME);
    if (!mascotLayer) {
        throw new Error(`Could not find smart object layer named ${MASCOT_LAYER_NAME}.`);
    }

    const phraseSmartObjectLayer = await findLayerByNameRecursive(doc.layers, PHRASE_SMART_OBJECT_NAME);
    if (!phraseSmartObjectLayer) {
        throw new Error(`Could not find phrase smart object layer named ${PHRASE_SMART_OBJECT_NAME}.`);
    }

    await logWorkflowEvent(`Applying phrase: ${phrase}`);
    await replaceSmartObjectContents(mascotLayer, designFile);
    await renameLayer(mascotLayer, MASCOT_LAYER_NAME);



    await setTextInsideSmartObject(phraseSmartObjectLayer, phrase, INNER_PHRASE_TEXT_LAYER_NAME);
    await renameLayer(phraseSmartObjectLayer, PHRASE_SMART_OBJECT_NAME);
}
async function exportPNG(doc, folder, fileName) {
    const file = await folder.createFile(fileName, { overwrite: true });
    const token = fs.createSessionToken(file);

    await action.batchPlay(
        [
            {
                _obj: "save",
                as: {
                    _obj: "PNGFormat",
                    method: {
                        _enum: "PNGMethod",
                        _value: "quick"
                    }
                },
                in: {
                    _path: token,
                    _kind: "local"
                },
                documentID: doc._id,
                copy: true,
                lowerCase: true
            }
        ],
        {
            synchronousExecution: true
        }
    );
}
async function getOrCreateSubfolder(parent, name) {
    const entries = await parent.getEntries();

    for (const entry of entries) {
        if (entry.isFolder && entry.name === name) {
            return entry;
        }
    }

    return await parent.createFolder(name);
}

async function runBatchPhraseWorkflow() {
    try {
        // Pick files OUTSIDE modal

        let inputFolder;
        let outputFolder;
		const { inputTokenKey, outputTokenKey } =
    getFolderTokenKeysForSelectedSource();
        try {

            inputFolder = await getRememberedFolder(
                inputTokenKey,
                "Select input folder"
            );

            outputFolder = await getRememberedFolder(
                outputTokenKey,
                "Select output folder"
            );
            updateFolderStatus(inputFolder, outputFolder);

        } catch (err) {
            console.log(`Could not find one of the expected child folders:${err}`);
            return null;
        }

        if (!inputFolder.isFolder || !outputFolder.isFolder) {
            console.log("One or both entries are not folders.");
            return null;
        }


        const sourceType = getSelectedPhraseSource();
        const items = await loadPhraseRecords(sourceType);


        if (!Array.isArray(items)) {
            throw new Error("JSON root must be an array.");
        }

        // Optional: build all file matches before touching Photoshop
        const workItems = [];
        for (const item of items) {
            const phrase = item?.Phrase;
            const folderName = item?.FolderName;
            const fileName = item?.Filename;

            if (!phrase || !folderName || !fileName) {
                console.warn("Skipping item due to missing phrase, folderName, or fileName:", item);
                continue;
            }

            const matchingFolder = await findSubfolderRecursive(inputFolder, folderName);
            if (!matchingFolder) {
                console.warn(`Could not find subfolder ${folderName} under ${inputFolder.name}.`);
                continue;
            }

            const designFile = await findFileInFolderByName(matchingFolder, fileName);
            if (!designFile) {
                console.warn(`Could not find file ${fileName} in folder ${matchingFolder.name}.`);
                continue;
            }

            workItems.push({
                phrase,
                designFile
            });
        }

        console.log(`Prepared ${workItems.length} items.`);

        // Do ONE Photoshop update per modal call
        for (const workItem of workItems) {
            try {
                await core.executeAsModal(async () => {
                    await applyPhraseAndMascot(workItem.phrase, workItem.designFile);
                    const doc = app.activeDocument;

                    // sanitize folder name
                    const safePhrase = workItem.phrase.replace(/[^\w\d]+/g, ".");

                    const phraseFolder = await getOrCreateSubfolder(outputFolder, safePhrase);

                    const baseName = workItem.designFile.name.replace(/\.[^/.]+$/, "");
                    const fileName = `${baseName}.png`;

                    console.log(`About to export ${fileName} to ${phraseFolder.nativePath}`);
                    await exportPNG(doc, phraseFolder, fileName);


                }, { commandName: `Apply ${workItem.phrase}` });

            } catch (err) {
                console.error(`Failed for phrase ${workItem.phrase}: ${err}`);
            }
        }

        console.log("Finished processing JSON items.");
    } catch (err) {
        console.error("runBatchPhraseWorkflow failed:", err);
    }
}



async function runBatchMockupGeneration() {
    try {
        console.log("runBatchMockupGeneration called");

        await runBatchPhraseWorkflow();

    } catch (err) {
        console.error("runBatchMockupGeneration failed:", err);
    }
}

async function findSubfolderRecursive(folder, targetFolderName) {
    const targetNorm = normalizeFolderName(targetFolderName);
    const entries = await folder.getEntries();

    for (const entry of entries) {
        if (entry.isFolder) {
            if (normalizeFolderName(entry.name) === targetNorm) {
                return entry;
            }

            const found = await findSubfolderRecursive(entry, targetFolderName);
            if (found) return found;
        }
    }

    return null;
}
async function getFileFromRelativePath(rootFolder, relativePath) {
    const parts = relativePath.split(/[\\/]/);
    let currentFolder = rootFolder;

    for (let i = 0; i < parts.length - 1; i++) {
        currentFolder = await currentFolder.getEntry(parts[i]);

        if (!currentFolder || !currentFolder.isFolder) {
            return null;
        }
    }

    return await currentFolder.getEntry(parts[parts.length - 1]);
}
async function findFileInFolderByName(folder, targetFileName) {
    const entries = await folder.getEntries();
    const targetNorm = normalizeFileName(targetFileName);

    for (const entry of entries) {
        if (entry.isFile && normalizeFileName(entry.name) === targetNorm) {
            return entry;
        }
    }

    return null;
}

function normalizeFolderName(name) {
    if (!name) return "";
    return name
        .normalize("NFKC")
        .replace(/\u2019/g, "’")
        .replace(/[']/g, "’")
        .replace(/\.+$/g, "")
        .trim()
        .toLowerCase();
}

function normalizeFileName(name) {
    if (!name) return "";
    return name
        .normalize("NFKC")
        .trim()
        .toLowerCase();
}

async function findLayerByNameRecursive(layers, targetName) {
    const target = targetName.toLowerCase();

    for (const layer of layers) {
        if ((layer.name || "").toLowerCase() === target) {
            return layer;
        }

        if (layer.layers && layer.layers.length > 0) {
            const found = await findLayerByNameRecursive(layer.layers, targetName);
            if (found) return found;
        }
    }

    return null;
}

async function replaceSmartObjectContents(layer, fileEntry) {
    const token = fs.createSessionToken(fileEntry);

    await action.batchPlay(
        [
            {
                _obj: "select",
                _target: [{ _ref: "layer", _id: layer.id }],
                makeVisible: false
            },
            {
                _obj: "placedLayerReplaceContents",
                null: {
                    _path: token,
                    _kind: "local"
                }
            }
        ],
        {
            synchronousExecution: true
        }
    );
}
async function logLayersRecursive(layers, depth = 0) {
    for (const layer of layers) {
        const indent = "  ".repeat(depth);
        await logWorkflowEvent(`${indent}- ${layer.name} (id: ${layer.id})`);

        if (layer.layers && layer.layers.length > 0) {
            await logLayersRecursive(layer.layers, depth + 1);
        }
    }
}


async function setTextLayerContents(layer, newText) {
    const result = await action.batchPlay(
        [
            {
                _obj: "get",
                _target: [{ _ref: "textLayer", _id: layer.id }]
            }
        ],
        { synchronousExecution: true }
    );

    const textDesc = result[0].textKey;

    const baseTextStyle =
        textDesc?.textStyleRange?.[0]?.textStyle || {};

    const baseParagraphStyle =
        textDesc?.paragraphStyleRange?.[0]?.paragraphStyle || {};

    await action.batchPlay(
        [
            {
                _obj: "set",
                _target: [{ _ref: "textLayer", _id: layer.id }],
                to: {
                    _obj: "textLayer",
                    textKey: newText,
                    textStyleRange: [
                        {
                            _obj: "textStyleRange",
                            from: 0,
                            to: newText.length,
                            textStyle: baseTextStyle
                        }
                    ],
                    paragraphStyleRange: [
                        {
                            _obj: "paragraphStyleRange",
                            from: 0,
                            to: newText.length,
                            paragraphStyle: baseParagraphStyle
                        }
                    ]
                }
            }
        ],
        { synchronousExecution: true }
    );
}
// Panel button hookup

document.addEventListener("DOMContentLoaded", () => {


    const runBatchButton = document.getElementById("btnRunPhraseImport");
    const psdDropdown = document.getElementById("psdPicker");
    const psdToOpen = document.getElementById("openSelectedPSD");

    if (!runBatchButton || !psdDropdown || !psdToOpen) {
        console.error("Required PSD UI elements missing");
        return;
    }

    runBatchButton.disabled = true;
    psdToOpen.disabled = true;



    const loadPsdFromJson = document.getElementById("loadPsdFromJson");
    const loadPsdFromDb = document.getElementById("loadPsdFromDb");


	
    const psdSourceGroup = document.getElementById("psdSourceGroup");

    if (!psdSourceGroup) {
        console.error("psdSourceGroup not found");
        return;
    }
    psdSourceGroup.addEventListener("change", updatePsdSourceButtons);

    async function resetFolder(tokenKey, promptLabel) {
        localStorage.removeItem(tokenKey);
        return await getRememberedFolder(tokenKey, promptLabel);
    }

	const changePSDRootFolder = document.getElementById("changePSDRootFolder");

if (changePSDRootFolder) {
    changePSDRootFolder.addEventListener("click", async () => {
        const tokenKey = getPsdRootFolderTokenKey();

        const folder = await resetFolder(
            tokenKey,
            "Select PSD Root Folder"
        );

        const el = document.getElementById("currentPSDRootFolder");
        if (el) {
            el.textContent = folder?.nativePath || "Not selected";
        }
    });
}

    const changeInputFolder = document.getElementById("changeInputFolder");
    if (changeInputFolder) {
        changeInputFolder.addEventListener("click", async () => {
            const { inputTokenKey,outputTokenKey } = getFolderTokenKeysForSelectedSource();
            const folder = await resetFolder(inputTokenKey, "Select New Input Folder");
       
            const outputFolder = await getRememberedFolder(outputTokenKey, null, false);

            updateFolderStatus(folder, outputFolder);
        });
    }

    const changeOutputFolder = document.getElementById("changeOutputFolder");
    if (changeOutputFolder) {
        changeOutputFolder.addEventListener("click", async () => {
    const { inputTokenKey, outputTokenKey } = getFolderTokenKeysForSelectedSource();

    const outputFolder = await resetFolder(outputTokenKey, "Select New Output Folder");
    const inputFolder = await getRememberedFolder(inputTokenKey, null, false);

    updateFolderStatus(inputFolder, outputFolder);
});
    }

    function updatePSDOpenButton() {
        psdToOpen.disabled = !psdDropdown.value;
    }



    function updatePsdSourceButtons() {
        const source = psdSourceGroup.value;

        loadPsdFromDb.disabled = source !== "db";
        loadPsdFromJson.disabled = source !== "json";

        psdDropdown.value = "";
        psdToOpen.disabled = true;
		refreshPsdRootFolderStatus();
    }

    loadPsdFromDb.addEventListener("click", async () => {
        await populatePSDDropdownFromDB();
        updatePSDOpenButton();
    });

    loadPsdFromJson.addEventListener("click", async () => {
        await populatePSDDropdownFromJsonFile();
        updatePSDOpenButton();
    });


    psdDropdown.addEventListener("change", updatePSDOpenButton);


    psdToOpen.addEventListener("click", async () => {
    try {
        if (!psdDropdown.value) {
            await app.showAlert("Please select a PSD first.");
            return;
        }

        await openSelectedTemplatePSD(psdDropdown);
		if (app.activeDocument) {
			runBatchButton.disabled = false;
		}
        
    } catch (err) {
        console.error("PSD open failed:", err);
        await app.showAlert(`PSD open failed:\n${err.message}`);
    }
});

	runBatchButton.addEventListener("click", async () => {
		await runBatchMockupGeneration();
	});

    updatePsdSourceButtons();

    const phraseSourceGroup = document.getElementById("phraseSourceGroup");

    if (phraseSourceGroup) {
        phraseSourceGroup.addEventListener("change", async () => {
            await refreshFoldersForSelectedSource();
        });
        refreshFoldersForSelectedSource();
    }

});






// Manifest command hookup
entrypoints.setup({
    commands: {
        runBatchMockupGeneration
    },
    panels: {
        mainPanel: {
            show() {
                showPanel();
            }
        },
    }
});