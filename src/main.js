const { PhotoshopPSDCollection } = require("./services/psdTemplateService.js");
const { loadPhraseRecords, loadPendingBatches, loadBatchReadyRecords} = require("./services/datasource.js");
const CONFIG = require("./config.js");


const { logWorkflowEvent } = require("./services/logService.js");
const { app, action, core, constants } = require("photoshop");
const { entrypoints, storage } = require("uxp");
const fs = storage.localFileSystem;

const MASCOT_LAYER_NAME = "mascot";
const PHRASE_SMART_OBJECT_NAME = "phrase";
const INNER_PHRASE_TEXT_LAYER_NAME = "phrase";
const PRINTABLE_WALL_ART_LAYER_NAME ="artwork";
let currentPSDWorkflowSteps =[];

function getSelectedBatchId() {
    const picker = document.getElementById("batchPicker");
    const menu = document.getElementById("batchMenu");

    const selectedValue = String(picker?.value || "");

    const valueStillExists = Array.from(
        menu?.querySelectorAll("sp-menu-item") || []
    ).some(item => String(item.value) === selectedValue);

    return valueStillExists ? selectedValue : "";
}
function getSelectedPhraseSource() {
    const group =
        document.getElementById("phraseSourceGroup");

    return group?.selected ||
        group?.getAttribute("selected") ||
        "db";
}
async function changePsdRootFolder() {
    const tokenKey = getPsdRootFolderTokenKey();

    // Intentionally forget the old root.
    localStorage.removeItem(tokenKey);

    const rootFolder = await getRememberedFolder(
        tokenKey,
        "Select PSD template library folder"
    );

    if (!rootFolder?.isFolder) {
        throw new Error(
            "A valid PSD template library folder was not selected."
        );
    }

    console.log(
        `PSD template library changed to: ${rootFolder.name}`
    );

    return rootFolder;
}
function getSelectedPsdSource() {
    const group = document.getElementById("psdSourceGroup");
    return group?.getAttribute("selected") || "db";
}
async function openPSDFromRoot(filePathName) {
    if (!filePathName) {
        throw new Error("A PSD filename is required.");
    }

    const tokenKey = getPsdRootFolderTokenKey();

    const rootFolder = await getRememberedFolder(
        tokenKey,
        "Select PSD template library folder"
    );

    if (!rootFolder?.isFolder) {
        throw new Error(
            "Choose the PSD template library folder before opening a template."
        );
    }

    console.log(
        `Resolving PSD "${filePathName}" ` +
        `from root "${rootFolder.name}"`
    );

    const psdFile = await getFileFromRelativePath(
        rootFolder,
        filePathName
    );

    if (!psdFile?.isFile) {
        throw new Error(
            `PSD template was not found: ${filePathName}`
        );
    }

    const templateDocument = await core.executeAsModal(
        async () => {
            return await app.open(psdFile);
        },
        {
            commandName: `Open PSD: ${filePathName}`
        }
    );

    console.log(
        `Opened PSD template: ${filePathName}`
    );

    return templateDocument;
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
    const psdDropdown = document.getElementById("psdDropdown");
    const openButton = document.getElementById("openSelectedPSD");

    if (!menu || !psdDropdown || !openButton) {
        console.error("Required PSD picker elements were not found.");
        return;
    }

    menu.innerHTML = "";
    psdDropdown.value = "";
    openButton.disabled = true;

    if (!Array.isArray(records) || records.length === 0) {
        console.warn("No PSD records were returned.");
        return;
    }

    for (const product of records) {
        const filePath = product.FilePathName;
        const description = product.Description || filePath;

        if (!filePath) {
            console.warn("Skipping PSD record without FilePathName:", product);
            continue;
        }

        const item = document.createElement("sp-menu-item");

        item.setAttribute("value", filePath);
        item.textContent = description;

        menu.appendChild(item);
    }

    // Allow Spectrum components to process the inserted menu items.
    await new Promise(resolve => setTimeout(resolve, 0));

    const firstRecord = records.find(record => record.FilePathName);

    if (firstRecord) {
        psdDropdown.value = firstRecord.FilePathName;
    }

    openButton.disabled = !psdDropdown.value;

}

async function populatePSDDropdownFromDB(productType = null) {
    console.log(
        "populatePSDDropdownFromDB started. Product type:",
        productType
    );
    try
    {
        const psdCollection = new PhotoshopPSDCollection();

        console.log("Requesting PSD records...");

        const records =
            await psdCollection.GetAllRecords();

        console.log("PSD records returned:", records);

        const matchingRecords = productType
            ? records.filter(record => {
                const recordProductType = String(
                    record.ProductType ??
                    record.productType ??
                    ""
                )
                    .trim()
                    .toLowerCase();

                const requestedProductType = String(productType)
                    .trim()
                    .toLowerCase();

                console.log(
                    "Comparing:",
                    recordProductType,
                    "to:",
                    requestedProductType
                );

                return recordProductType === requestedProductType;
            })
            : records;

        const orderedRecords = [...matchingRecords].sort((a, b) => {
            const stepA = Number(
                a.WorkflowStep ??
                a.workflowStep ??
                0
            );

            const stepB = Number(
                b.WorkflowStep ??
                b.workflowStep ??
                0
            );

            return stepA - stepB;
        });

        currentPSDWorkflowSteps = orderedRecords;
        console.log(
            "Stored PSD workflow steps:",
            currentPSDWorkflowSteps
        );

        console.log("Ordered PSD workflow records:", orderedRecords);

        await populatePSDDropdownFromRecords(orderedRecords);
    }
    catch (error) {
        console.error(
            "populatePSDDropdownFromDB failed:",
            error
        );
        console.error(error?.stack);
    }
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

async function openSelectedTemplatePSD(picker) {
    const relativePath = getPickerValue(picker);

    console.log(
        "Open Template selected path:",
        relativePath
    );

    if (!relativePath) {
        throw new Error(
            "No PSD template is selected."
        );
    }

    return await openPSDFromRoot(relativePath);
}

const workflowProcessors = new Map([
    [
        "artwork",
        async ({ templateDoc, items }) => {
            await runArtworkWorkflow(
                templateDoc,
                items,
                { finalizeRecords: false }
            );
        }
    ],
    [
        "mockup",
        async ({ templateDoc, items }) => {
            await runMockupWorkflow(
                templateDoc,
                items
            );
        }
    ],
    [
        "printable-wall-art",
        async ({ templateDoc, items }) => {
            await runPrintableWallArtWorkflow(
                templateDoc,
                items
            );
        }
    ]
]);
function getWorkflowStepDefinition(
    productType,
    stepNumber
) {
    const productWorkflow =
        workflowDefinitions.get(productType);

    if (!productWorkflow) {
        throw new Error(
            `Unsupported product type: ${productType}`
        );
    }

    const stepDefinition =
        productWorkflow.get(stepNumber);

    if (!stepDefinition) {
        throw new Error(
            `Unsupported workflow step ${stepNumber} ` +
            `for product type ${productType}`
        );
    }

    return stepDefinition;
}
const workflowDefinitions = new Map([
    [
        "tshirt",
        new Map([
            [
                10,
                {
                    processorKey: "artwork"
                }
            ],
            [
                20,
                {
                    processorKey: "mockup"
                }
            ]
        ])
    ],
    [
        "printable-wall-art",
        new Map([
            [
                10,
                {
                    processorKey: "printable-wall-art"
                }
            ]
        ])
    ]
]);
async function dispatchWorkflowStep(
    stepNumber,
    context
) {
    const productType =
        context?.productType;

    if (!productType) {
        throw new Error(
            "Workflow execution requires a product type."
        );
    }

    const stepDefinition =
        getWorkflowStepDefinition(
            productType,
            stepNumber
        );

    const processorKey =
        stepDefinition.processorKey;

    const processor =
        workflowProcessors.get(processorKey);

    if (!processor) {
        throw new Error(
            `No workflow processor is registered ` +
            `for key: ${processorKey}`
        );
    }

    console.log(
        `Dispatching workflow step ${stepNumber} ` +
        `for product type ${productType} ` +
        `using processor ${processorKey}`
    );

    return await processor(context);
}

async function openWorkflowTemplate(workflowRecord) {

    if (!workflowRecord) {
        throw new Error("Workflow record is required.");
    }

    return await openPSDFromRoot(workflowRecord.FilePathName);
}
function showPanel() {
    const mainPanelSection = document.getElementById("mainPanelSection");

    if (mainPanelSection) {
        mainPanelSection.classList.remove("hidden");
    }
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
async function applyArtworkToMockup(doc, artworkFile) {
    if (!doc) {
        throw new Error("No active Photoshop document.");
    }

    const mascotLayer = await findLayerByNameRecursive(
        doc.layers,
        MASCOT_LAYER_NAME
    );

    if (!mascotLayer) {
        throw new Error(
            `Could not find smart object layer named ${MASCOT_LAYER_NAME}.`
        );
    }

    await replaceSmartObjectContents(
        mascotLayer,
        artworkFile
    );

    await renameLayer(
        mascotLayer,
        MASCOT_LAYER_NAME
    );
}
async function applyPhraseAndMascot(doc,phrase, designFile) {
    if (!doc) {
        throw new Error("No active Photoshop document.");
    }

    await logLayersRecursive(doc.layers);

    const mascotLayer = await findLayerByNameRecursive(doc.layers, MASCOT_LAYER_NAME);
    if (!mascotLayer) {
        throw new Error(`Could not find smart object layer named ${MASCOT_LAYER_NAME}.`);
    }

    const phraseSmartObjectLayer = await findLayerByNameRecursive(doc.layers, PHRASE_SMART_OBJECT_NAME);
    await logWorkflowEvent(`Applying phrase: ${phrase}`);
    await replaceSmartObjectContents(mascotLayer, designFile);
    await renameLayer(mascotLayer, MASCOT_LAYER_NAME);


    if (!phraseSmartObjectLayer) {
        console.log(`Could not find phrase smart object layer named ${PHRASE_SMART_OBJECT_NAME}.`);
    }
    else
    {
    await setTextInsideSmartObject(phraseSmartObjectLayer, phrase, INNER_PHRASE_TEXT_LAYER_NAME);
    await renameLayer(phraseSmartObjectLayer, PHRASE_SMART_OBJECT_NAME);
    }
}

const GROUP_PREFIX = "Group ";

async function getMockupGroups(doc) {
    const groups = [];

    for (const layer of doc.layers) {
        if (
            layer.layers &&
            layer.name &&
            layer.name.startsWith(GROUP_PREFIX)
        ) {
            groups.push(layer);
        }
    }

    return groups;
}

async function exportEachMockupGroup(doc, folder, baseName) {
    const groups = await getMockupGroups(doc);

     if (groups.length === 0) {
        const fileName = `${baseName}.png`;
        console.log(`No groups found. Exporting whole PSD as ${fileName}`);
        await exportPNG(doc, folder, fileName);
        return;
    }

    const originalVisibility = groups.map(group => ({
        group,
        visible: group.visible
    }));

    try {
        for (const group of groups) {
            for (const item of originalVisibility) {
                item.group.visible = false;
            }

            group.visible = true;

            const safeGroupName = group.name.replace(/[^\w\d]+/g, ".");
            const fileName = `${baseName}-${safeGroupName}.png`;

            console.log(`Exporting ${fileName}`);
            await exportPNG(doc, folder, fileName);
        }
    } finally {
        for (const item of originalVisibility) {
            item.group.visible = item.visible;
        }
    }
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
async function markMockupFailed(recordId, errorMessage) {
    if (!recordId) {
        throw new Error(
            "Cannot mark mockup failed: missing record id."
        );
    }

    const url =
        `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.MOCKUP_FAILED(
            encodeURIComponent(recordId)
        )}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            error: errorMessage
        })
    });

    if (!response.ok) {
        throw new Error(
            `Failed to record mockup failure: ${response.status}`
        );
    }

    return await response.json();
}
async function runArtworkWorkflow(
    templateDoc,
    items,
    { finalizeRecords = true } = {}
) {
    try {
        let inputFolder;
        let outputFolder;

        const {
            inputTokenKey,
            outputTokenKey
        } = getFolderTokenKeysForSelectedSource();

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
            console.error(
                "Could not find one of the expected folders:",
                err
            );
            return;
        }

        if (!inputFolder?.isFolder || !outputFolder?.isFolder) {
            console.error("One or both entries are not folders.");
            return;
        }

        const batchPicker =
            document.getElementById("batchPicker");

        const selectedBatchId =
            getPickerValue(batchPicker);

        if (finalizeRecords && !selectedBatchId) {
            throw new Error(
                "A selected batch is required to finalize artwork records."
            );
        }
        if (!Array.isArray(items)) {
            throw new Error("Record source must return an array.");
        }
        if (items.length === 0) {
            await app.showAlert(
                "No unfinished records were returned for the selected batch."
        );
            return;
        }
        if (!templateDoc) {
            throw new Error(
                "A template document is required for the phrase workflow."
            );
        }

        let completed = 0;
        let failed = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];

            const phrase =
                item?.Phrase ??
                item?.phrase;

            const folderName =
                item?.FolderName ??
                item?.folderName;

            const fileName =
                item?.Filename ??
                item?.filename ??
                item?.fileName;

            const recordId =
                item?.id ??
                item?.Id;


            const productType =
                item?.ProductType ??
                item?.productType ??
                "tshirt";

            const inputFolderPath =
                item?.InputFolderPath ??
                item?.inputFolderPath;

            if (
                !recordId ||
                !phrase ||
                !folderName ||
                !fileName ||
                !inputFolderPath
            ) {
                console.warn("Skipping incomplete record:", item);
                failed++;
                continue;
            }

            let workingDoc = null;

            try {
                console.log(
                    `Processing ${index + 1} of ${items.length}: ${phrase}`
                );


                const pngPath =
                    `${inputFolderPath}/${fileName}`;

                const designFile =
                    await getPngFileFromApi(
                        pngPath,
                        fileName
                    );

                await core.executeAsModal(
                    async () => {
                        workingDoc =
                            await templateDoc.duplicate();

                        await applyPhraseAndMascot(
                            workingDoc,
                            phrase,
                            designFile
                        );

                        const mockupFolder =
                            await getOrCreateSubfolder(
                                outputFolder,
                                folderName
                            );

                        const baseName =
                            designFile.name.replace(
                                /\.[^/.]+$/,
                                ""
                            );

                        await exportEachMockupGroup(
                            workingDoc,
                            mockupFolder,
                            baseName
                        );

                        if (finalizeRecords) {
                            await uploadMockupFolderToApi(
                                mockupFolder,
                                selectedBatchId,
                                productType,
                                folderName
                            );
                            await markMockupComplete(recordId);
                        }
                    },
                    {
                        commandName: `Apply ${phrase}`
                    }
                );

                completed++;
            } catch (err) {
                failed++;

                console.error(
                    `Failed ${index + 1}/${items.length}: ${phrase}`,
                    err
                );

                try {
                    await markMockupFailed(
                        recordId,
                        err?.message ?? String(err)
                    );
                } catch (markErr) {
                    console.error(
                        `Could not record failure for ${phrase}:`,
                        markErr
                    );
                }
            } finally {
                if (workingDoc) {
                    try {
                        await core.executeAsModal(
                            async () => {
                                await workingDoc.closeWithoutSaving();
                            },
                            {
                                commandName:
                                    "Close Working Document"
                            }
                        );
                    } catch (closeErr) {
                        console.error(
                            `Could not close document for ${phrase}:`,
                            closeErr
                        );
                    }

                    workingDoc = null;
                }
            }
        }

        const result = {
            processed: completed,
            failed
        };

        console.log(
            `Workflow step finished. Processed: ${result.processed}; ` +
            `Failed: ${result.failed}.`
        );

        return result;
    } catch (err) {
        console.error(
            "runArtworkWorkflow failed:",
            err
        );
        console.error(err?.stack);
    }

}
async function runMockupWorkflow(
    templateDoc,
    items
) {
    if (!templateDoc) {
        throw new Error(
            "A template document is required for the background mockup workflow."
        );
    }

    const {
        outputTokenKey
    } = getFolderTokenKeysForSelectedSource();

    const outputFolder = await getRememberedFolder(
        outputTokenKey,
        "Select output folder"
    );

    if (!outputFolder?.isFolder) {
        throw new Error("The output folder is not available.");
    }

    const batchPicker =
        document.getElementById("batchPicker");

    const selectedBatchId =
        getPickerValue(batchPicker);

    if (!selectedBatchId) {
        throw new Error("Please select a pending batch.");
    }
    if (!Array.isArray(items)) {
        throw new Error(
            "Batch record source must return an array."
        );
    }

    if (items.length === 0) {
        throw new Error(
            "No unfinished records were returned for Step 20."
        );
    }

    let processed = 0;
    let failed = 0;

    for (let index = 0; index < items.length; index++) {
        const item = items[index];

        const phrase =
            item?.Phrase ??
            item?.phrase;

        const folderName =
            item?.FolderName ??
            item?.folderName;

        const fileName =
            item?.Filename ??
            item?.filename ??
            item?.fileName;

        const recordId =
            item?.Id ??
            item?.id;

        const productType =
            item?.ProductType ??
            item?.productType ??
            "tshirt";

        if (
            !recordId ||
            !folderName ||
            !fileName
        ) {
            console.warn(
                "Skipping incomplete Step 20 record:",
                item
            );

            failed++;
            continue;
        }

        let workingDoc = null;

        try {
            console.log(
                `Step 20 processing ${index + 1} of ` +
                `${items.length}: ${phrase}`
            );

            const mockupFolder =
                await getOrCreateSubfolder(
                    outputFolder,
                    folderName
                );

            const baseName =
                fileName.replace(/\.[^/.]+$/, "");

            const intermediateFileName =
                `${baseName}.png`;

            const artworkFile =
                await findFileInFolderByName(
                    mockupFolder,
                    intermediateFileName
                );

            if (!artworkFile) {
                throw new Error(
                    `Step 10 artwork was not found: ` +
                    `${folderName}/${intermediateFileName}`
                );
            }

            await core.executeAsModal(
                async () => {
                    workingDoc =
                        await templateDoc.duplicate();

                    await applyArtworkToMockup(
                        workingDoc,
                        artworkFile
                    );

                    await exportEachMockupGroup(
                        workingDoc,
                        mockupFolder,
                        baseName
                    );
                },
                {
                    commandName:
                        `Generate background mockups for ${phrase}`
                }
            );

            await uploadMockupFolderToApi(
                mockupFolder,
                selectedBatchId,
                productType,
                folderName
            );

            await markMockupComplete(recordId);

            processed++;
        } catch (err) {
            failed++;

            console.error(
                `Step 20 failed ${index + 1}/` +
                `${items.length}: ${phrase}`,
                err
            );

            try {
                await markMockupFailed(
                    recordId,
                    err?.message ?? String(err)
                );
            } catch (markErr) {
                console.error(
                    `Could not record Step 20 failure for ${phrase}:`,
                    markErr
                );
            }
        } finally {
            if (workingDoc) {
                try {
                    await core.executeAsModal(
                        async () => {
                            await workingDoc.closeWithoutSaving();
                        },
                        {
                            commandName:
                                "Close Background Mockup Document"
                        }
                    );
                } catch (closeErr) {
                    console.error(
                        `Could not close Step 20 document for ${phrase}:`,
                        closeErr
                    );
                }

                workingDoc = null;
            }
        }
    }

    const result = {
        processed,
        failed
    };

    console.log(
        `Step 20 finished. Processed: ${result.processed}; ` +
        `Failed: ${result.failed}.`
    );

    return result;
}
async function exportPrintableWallArtPng(
    document,
    outputFolder,
    folderName,
    sourceFileName
) {
    const recordOutputFolder =
        await getOrCreateChildFolder(
            outputFolder,
            folderName
        );

    const baseName =
        removeFileExtension(
            sourceFileName
        );

    const outputFileName =
        `${baseName}-printable-wall-art.png`;

    const outputFile =
        await recordOutputFolder.createFile(
            outputFileName,
            {
                overwrite: true
            }
        );

    await document.saveAs.png(
        outputFile,
        {
            compression: 6,
            interlaced: false
        },
        true
    );

    return outputFile;
}
async function getOrCreateChildFolder(
    parentFolder,
    folderName
) {
    try {
        const existingEntry =
            await parentFolder.getEntry(
                folderName
            );

        if (!existingEntry?.isFolder) {
            throw new Error(
                `Output entry is not a folder: ${folderName}`
            );
        }

        return existingEntry;
    } catch (err) {
        try {
            return await parentFolder.createFolder(
                folderName
            );
        } catch (createError) {
            throw new Error(
                `Could not access or create output folder ` +
                `"${folderName}": ${createError.message}`
            );
        }
    }
}
function removeFileExtension(fileName) {
    if (!fileName) {
        return "printable-wall-art";
    }

    const lastDot =
        fileName.lastIndexOf(".");

    if (lastDot <= 0) {
        return fileName;
    }

    return fileName.substring(
        0,
        lastDot
    );
}
function findLayerByName(
    layers,
    targetName
) {
    if (!layers || !targetName) {
        return null;
    }

    const normalizedTarget =
        targetName.trim().toLowerCase();

    for (const layer of layers) {
        const normalizedLayerName =
            layer.name?.trim().toLowerCase();

        if (normalizedLayerName === normalizedTarget) {
            return layer;
        }

        if (layer.layers?.length) {
            const nestedLayer =
                findLayerByName(
                    layer.layers,
                    targetName
                );

            if (nestedLayer) {
                return nestedLayer;
            }
        }
    }

    return null;
}

async function ensureUxpFileEntry(
    source,
    fileName
) {
    if (source?.isFile) {
        return source;
    }

    const temporaryFolder =
        await fs.getTemporaryFolder();

    const temporaryFile =
        await temporaryFolder.createFile(
            fileName,
            {
                overwrite: true
            }
        );

    if (source instanceof ArrayBuffer) {
        await temporaryFile.write(
            source,
            {
                format:
                    storage.formats.binary
            }
        );

        return temporaryFile;
    }

    if (ArrayBuffer.isView(source)) {
        const buffer =
            source.buffer.slice(
                source.byteOffset,
                source.byteOffset +
                source.byteLength
            );

        await temporaryFile.write(
            buffer,
            {
                format:
                    storage.formats.binary
            }
        );

        return temporaryFile;
    }

    if (source?.arrayBuffer instanceof Function) {
        const buffer =
            await source.arrayBuffer();

        await temporaryFile.write(
            buffer,
            {
                format:
                    storage.formats.binary
            }
        );

        return temporaryFile;
    }

    throw new Error(
        `The downloaded artwork is not a UXP file ` +
        `or supported binary value: ${fileName}`
    );
}
async function runPrintableWallArtWorkflow(
    templateDoc,
    items
) {
    if (!templateDoc) {
        throw new Error(
            "A template document is required for printable wall art."
        );
    }

    if (!Array.isArray(items)) {
        throw new Error(
            "Printable wall-art record source must return an array."
        );
    }

    const {
        outputTokenKey
    } = getFolderTokenKeysForSelectedSource();

    const outputFolder = await getRememberedFolder(
        outputTokenKey,
        "Select output folder"
    );

    if (!outputFolder?.isFolder) {
        throw new Error(
            "The output folder is not available."
        );
    }

    const selectedBatchId =
        getSelectedBatchId();

    if (!selectedBatchId) {
        throw new Error(
            "Please select a pending batch."
        );
    }

    console.log(
        `Printable wall-art workflow received ${items.length} record(s).`
    );
    let processed = 0;
    let failed = 0;

    for (let index = 0; index < items.length; index++) {
        const item = items[index];

        const recordId =
            item?.Id ??
            item?.id;

        const folderName =
            item?.FolderName ??
            item?.folderName;

        const fileName =
            item?.Filename ??
            item?.filename ??
            item?.fileName;

        const inputFolderPath =
            item?.InputFolderPath ??
            item?.inputFolderPath;

        if (
            !recordId ||
            !folderName ||
            !fileName ||
            !inputFolderPath
        ) {
            console.warn(
                "Skipping incomplete printable wall-art record:",
                item
            );

            failed++;
            continue;
        }

        try {
            console.log(
                `Printable wall art ${index + 1} of ` +
                `${items.length}: ${fileName}`
            );

            const pngPath =
                `${inputFolderPath}/${fileName}`;

            const downloadedArtwork =
                await getPngFileFromApi(
                    pngPath,
                    fileName
                );

            const artworkFile =
                await ensureUxpFileEntry(
                    downloadedArtwork,
                    fileName
                );

            console.log(
                `Loaded printable wall-art source: ` +
                `${artworkFile.name}; ` +
                `isFile=${artworkFile.isFile}`
            );
            const workingDocument =
                await core.executeAsModal(
                    async () => {
                        return await templateDoc.duplicate();
                    },
                    {
                        commandName:
                            "Duplicate printable wall-art template"
                    }
                );

            console.log(
                `Created working document: ${workingDocument.title}`
            );

            let exportedFile;

            try {
                exportedFile =
                    await core.executeAsModal(
                        async () => {
                            const artworkLayer =
                                findLayerByName(
                                    workingDocument.layers,
                                    PRINTABLE_WALL_ART_LAYER_NAME
                                );

                            if (!artworkLayer) {
                                throw new Error(
                                    `Printable wall-art layer not found: ` +
                                    `${PRINTABLE_WALL_ART_LAYER_NAME}`
                                );
                            }

                            await replaceSmartObjectContents(
                                artworkLayer,
                                artworkFile
                            );

                            console.log(
                                `Replaced printable wall-art layer ` +
                                `"${PRINTABLE_WALL_ART_LAYER_NAME}".`
                            );

                            const outputFile =
                                await exportPrintableWallArtPng(
                                    workingDocument,
                                    outputFolder,
                                    folderName,
                                    fileName
                                );

                            console.log(
                                `Exported printable wall art: ` +
                                `${outputFile.name}`
                            );

                            await workingDocument.close(
                                constants.SaveOptions
                                    .DONOTSAVECHANGES
                            );

                            return outputFile;
                        },
                        {
                            commandName:
                                "Replace and export printable wall art"
                        }
                    );
            } catch (workflowError) {
                try {
                    if (
                        workingDocument &&
                        app.documents.some(
                            document =>
                                document.id ===
                                workingDocument.id
                        )
                    ) {
                        await core.executeAsModal(
                            async () => {
                                await workingDocument.close(
                                    constants.SaveOptions
                                        .DONOTSAVECHANGES
                                );
                            },
                            {
                                commandName:
                                    "Close failed printable wall-art document"
                            }
                        );
                    }
                } catch (closeError) {
                    console.error(
                        "Failed to close printable wall-art document:",
                        closeError
                    );
                }

                throw workflowError;
            }

            if (!exportedFile?.isFile) {
                throw new Error(
                    `Printable wall-art export was not created ` +
                    `for record ${recordId}.`
                );
            }
            const productType =
                item?.ProductType ??
                item?.productType ??
                "printable-wall-art";

            await uploadMockupFileToApi(
                exportedFile,
                selectedBatchId,
                productType,
                folderName
            );
            console.log(
                `Marking printable wall-art record complete: ${recordId}`
            );

            await markMockupComplete(recordId);

            console.log(
                `Printable wall-art record marked complete: ${recordId}`
            );

            processed++;
        } catch (err) {
            failed++;

            console.error(
                `Printable wall-art item failed ` +
                `${index + 1}/${items.length}:`,
                err
            );
        }
    }

    return {
        processed,
        failed
    };
}
async function getPngFileFromApi(containerPath, fileName) {
    const relativePath = containerPath.replace(/^\/data\/builds\//, "");
    const url =
        `${CONFIG.PNG_API_BASE_URL}${CONFIG.ENDPOINTS.FILE(relativePath)}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch PNG from ${url}: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();

    const tempFolder = await fs.getTemporaryFolder();
    const tempFile = await tempFolder.createFile(fileName, { overwrite: true });

    await tempFile.write(arrayBuffer, { format: storage.formats.binary });

    return tempFile;
}
async function runBatchMockupGeneration() {
    let selectedBatchId = null;
    let shouldTrackBatchStatus = false;

    try {

        console.log("runBatchMockupGeneration called");

        if (
            !Array.isArray(currentPSDWorkflowSteps) ||
            currentPSDWorkflowSteps.length === 0
        ) {
            throw new Error(
                "No PSD workflow steps are loaded."
            );
        }

        const sourceType =
            getSelectedPhraseSource();

        const batchPicker =
            document.getElementById("batchPicker");

        selectedBatchId =
            getPickerValue(batchPicker);

        const productType =
            getSelectedProductType();

        if (!productType) {
            throw new Error(
                "A product type is required for the selected batch."
            );
        }
        let items;

        if (sourceType === "db") {
            if (!selectedBatchId) {
                throw new Error(
                    "Please select a pending batch."
                );
            }

            items = await loadBatchReadyRecords(
                selectedBatchId
            );

            shouldTrackBatchStatus = true;

            items = items;
        } else {
            items = await loadPhraseRecords(
                sourceType
            );
        }

        if (!Array.isArray(items)) {
            throw new Error(
                "Workflow record source must return an array."
            );
        }

        if (items.length === 0) {
            throw new Error(
                "No unfinished records were returned."
            );
        }

        console.log(
            `Loaded ${items.length} workflow records.`
        );

        if (shouldTrackBatchStatus) {
            // await updateBatchProcessingStatus(
            //     selectedBatchId,
            //     {
            //         processingStatus: "processing",
            //         mockupProcessed: false,
            //         mockupError: null
            //     }
            // );
        }

        for (
            const workflowStep
            of currentPSDWorkflowSteps
        ) {
            const stepNumber = Number(
                workflowStep.WorkflowStep ??
                workflowStep.workflowStep
            );

            const filePathName =
                workflowStep.FilePathName ??
                workflowStep.filePathName;

            console.log(
                `Running workflow step ${stepNumber}:`,
                filePathName
            );

            const templateDoc =
                await openWorkflowTemplate(
                    workflowStep
                );

            try {
                const stepResult =
                    await dispatchWorkflowStep(
                        stepNumber,
                        {
                            workflowStep,
                            templateDoc,
                            filePathName,
                            items,
                            productType

                        }
                    );

                if (stepResult?.failed > 0) {
                    console.warn(
                        `Workflow step ${stepNumber} completed with ` +
                        `${stepResult.failed} failed record(s).`
                    );
                }
            } finally {
                await core.executeAsModal(
                    async () => {
                        await templateDoc
                            .closeWithoutSaving();
                    },
                    {
                        commandName:
                            `Close workflow template ${filePathName}`
                    }
                );
            }
        }

        if (shouldTrackBatchStatus) {
            // await updateBatchProcessingStatus(
            //     selectedBatchId,
            //     {
            //         processingStatus: "completed",
            //         mockupProcessed: true,
            //         mockupError: null
            //     }
            // );
        }

        console.log(
            "All PSD workflow steps finished."
        );
    } catch (err) {
        console.error(
            "runBatchMockupGeneration failed:",
            err
        );

        if (
            shouldTrackBatchStatus &&
            selectedBatchId
        ) {
            const errorMessage =
                err instanceof Error
                    ? err.message
                    : String(err);

            try {
                // await updateBatchProcessingStatus(
                //     selectedBatchId,
                //     {
                //         processingStatus: "failed",
                //         mockupProcessed: false,
                //         mockupError: errorMessage
                //     }
                // );
            } catch (statusError) {
                // console.error(
                //     "Could not update failed batch status:",
                //     statusError
                // );
            }
        }

        throw err;
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
async function getFileFromRelativePath(
    rootFolder,
    relativePath
) {
    if (!rootFolder?.isFolder) {
        throw new Error(
            "A valid root folder is required."
        );
    }

    if (!relativePath) {
        throw new Error(
            "A relative file path is required."
        );
    }

    const pathParts = relativePath
        .replace(/\\/g, "/")
        .split("/")
        .map(part => part.trim())
        .filter(Boolean);

    if (pathParts.length === 0) {
        throw new Error(
            `The relative path is invalid: ${relativePath}`
        );
    }

    let currentEntry = rootFolder;

    console.log(
        `Resolving PSD path "${relativePath}" ` +
        `from root "${rootFolder.name}"`
    );

    for (let index = 0; index < pathParts.length; index++) {
        const pathPart = pathParts[index];
        const isLastPart =
            index === pathParts.length - 1;

        if (!currentEntry?.isFolder) {
            throw new Error(
                `Cannot resolve "${pathPart}" because ` +
                `"${currentEntry?.name}" is not a folder.`
            );
        }

        const childEntries =
            await currentEntry.getEntries();

        console.log(
            `Entries inside "${currentEntry.name}":`,
            childEntries.map(entry => ({
                name: entry.name,
                isFolder: entry.isFolder,
                isFile: entry.isFile
            }))
        );

        const matchingEntry = childEntries.find(
            entry =>
                entry.name.toLowerCase() ===
                pathPart.toLowerCase()
        );

        if (!matchingEntry) {
            const resolvedParent = pathParts
                .slice(0, index)
                .join("/") || rootFolder.name;

            const availableNames = childEntries
                .map(entry => entry.name)
                .join(", ");

            throw new Error(
                `Template path entry was not found: ` +
                `"${pathPart}". ` +
                `Current folder: "${currentEntry.name}". ` +
                `Resolved parent: "${resolvedParent}". ` +
                `Available entries: ` +
                `${availableNames || "(none)"}. ` +
                `Original path: "${relativePath}".`
            );
        }

        if (!isLastPart && !matchingEntry.isFolder) {
            throw new Error(
                `Expected a folder at: ` +
                `${pathParts
                    .slice(0, index + 1)
                    .join("/")}`
            );
        }

        currentEntry = matchingEntry;
    }

    if (!currentEntry?.isFile) {
        throw new Error(
            `The resolved template is not a file: ` +
            `${relativePath}`
        );
    }

    return currentEntry;
}
function getSelectedProductType() {
    const productType = document
        .getElementById("selectedProductType")
        ?.textContent
        ?.trim();

    return productType && productType !== "Unknown"
        ? productType
        : null;
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
    if (!layer) {
        throw new Error(
            "A target Smart Object layer is required."
        );
    }

    if (
        !fileEntry ||
        fileEntry.isFile !== true
    ) {
        console.error(
            "Invalid Smart Object replacement entry:",
            fileEntry
        );

        throw new Error(
            "The replacement image must be a UXP File entry."
        );
    }

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

document.addEventListener("DOMContentLoaded", async () => {

    const generationStatus = document.getElementById("generationStatus");

    let isGenerating = false;
    let generationCompleted = false;

    const runBatchButton = document.getElementById("btnRunPhraseImport");
    const psdDropdown = document.getElementById("psdDropdown");
    const psdToOpen = document.getElementById("openSelectedPSD");
    const batchPicker = document.getElementById("batchPicker");
    const loadPendingBatchesButton = document.getElementById("loadPendingBatches");
    const loadPsdFromJson = document.getElementById("loadPsdFromJson");
    const loadPsdFromDb = document.getElementById("loadPsdFromDb");
    const changePSDRootFolder = document.getElementById("changePSDRootFolder");
    const changeInputFolder = document.getElementById("changeInputFolder");

    const psdSourceGroup = document.getElementById("psdSourceGroup");
    const phraseSourceGroup = document.getElementById("phraseSourceGroup");
    const changeOutputFolder = document.getElementById("changeOutputFolder");
    const toggleAdvancedButton = document.getElementById("toggleAdvanced");
    const advancedPanel = document.getElementById("advancedPanel");

    const batchMenu = document.getElementById("batchMenu");

    if (!runBatchButton || !psdDropdown || !psdToOpen) {
        console.error("Required PSD UI elements missing");
        return;
    }

    runBatchButton.disabled = true;
    psdToOpen.disabled = true;
    function updateBatchSummary() {
        const selectedValue = getPickerValue(batchPicker);

        const selectedOption = Array.from(
             batchMenu?.querySelectorAll("sp-menu-item") ?? [])
            .find(item => item.value === selectedValue);
        const batchStatus =
            document.getElementById("selectedBatchStatus");

        const productTypeStatus =
            document.getElementById("selectedProductType");

        const itemCountStatus =
            document.getElementById("selectedBatchItemCount");

        if (!selectedOption) {
            if (batchStatus) {
                batchStatus.textContent = "None";
            }

            if (productTypeStatus) {
                productTypeStatus.textContent = "Unknown";
            }

            if (itemCountStatus) {
                itemCountStatus.textContent = "0";
            }

            return;
        }

        const batchId =
            selectedOption.dataset.batchId ||
            getSelectedBatchId() ||
            "None";

        const productType =
            selectedOption.dataset.productType ||
            "Unknown";

        const itemCount =
            selectedOption.dataset.itemCount ||
            "0";

        if (batchStatus) {
            batchStatus.textContent = batchId;
        }

        if (productTypeStatus) {
            productTypeStatus.textContent = productType;
        }

        if (itemCountStatus) {
            itemCountStatus.textContent = itemCount;
        }
    }
    function updateRunButtonState() {

        const sourceType = getSelectedPhraseSource();
        const selectedBatchId =
            getSelectedBatchId();

        console.log("sourceType:", sourceType);
        console.log("selectedBatchId:", selectedBatchId);

        const selectedTemplate =
            getPickerValue(psdDropdown);
        if (isGenerating) {
            runBatchButton.disabled = true;
            runBatchButton.textContent = "Generating...";
            generationStatus.textContent = "Generating...";
            return;
        }

        if (sourceType === "db" && !selectedBatchId) {
            runBatchButton.disabled = true;
            runBatchButton.textContent = "Select a Batch";
            generationStatus.textContent = "Waiting for batch selection";
            return;
        }

        if (!selectedTemplate) {
            runBatchButton.disabled = true;
            runBatchButton.textContent = "Select a Template";
            generationStatus.textContent = "Waiting for template selection";
            return;
        }

        if (generationCompleted) {
            runBatchButton.disabled = true;
            runBatchButton.textContent = "Completed";
            generationStatus.textContent = "Completed";
            return;
        }

        runBatchButton.disabled = false;
        runBatchButton.textContent = "Generate Mockups";
        generationStatus.textContent = "Ready";
    }
    if (batchPicker) {
        batchPicker.addEventListener("change", () => {
            handleBatchSelectionChanged();
        });
    }

    if (!psdSourceGroup) {
        console.error("psdSourceGroup not found");
        return;
    }
    psdSourceGroup.addEventListener("change", async () => {
        await updatePsdSourceButtons();
        refreshUiState();
    });

    async function resetFolder(tokenKey, promptLabel) {
        localStorage.removeItem(tokenKey);
        return await getRememberedFolder(tokenKey, promptLabel);
    }


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

    if (changeInputFolder) {
        changeInputFolder.addEventListener("click", async () => {
            const { inputTokenKey,outputTokenKey } = getFolderTokenKeysForSelectedSource();
            const folder = await resetFolder(inputTokenKey, "Select New Input Folder");
       
            const outputFolder = await getRememberedFolder(outputTokenKey, null, false);

            updateFolderStatus(folder, outputFolder);
        });
    }

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

    async function handleBatchSelectionChanged() {
        generationCompleted = false;

        updateBatchSummary();

        const productType = getSelectedProductType();

        console.log(
            "Batch selection updated. Product type:",
            productType
        );

        if (getSelectedPsdSource() === "db") {
            await populatePSDDropdownFromDB(productType);
        }

        updatePSDOpenButton();
        updateRunButtonState();
    }

    async function populatePendingBatches() {
        const batches = await loadPendingBatches();
        const menu = document.getElementById("batchMenu");
        const picker = document.getElementById("batchPicker");

        if (!menu || !picker) {
            console.warn("Batch picker or menu was not found.");
            return;
        }

        // Clear the picker's public selection first.
        picker.value = "";

        // Clear selection state maintained by existing menu items.
        for (const item of menu.querySelectorAll("sp-menu-item")) {
            item.selected = false;
            item.removeAttribute("selected");
        }

        // Remove the old options.
        menu.replaceChildren();

        // Add the current options.
        for (const batch of batches) {
            const batchId = String(
                batch.batchId || batch.BatchId
            );

            const productType = String(
                batch.productType || batch.ProductType || ""
            );

            const itemCount = String(
                batch.itemCount || batch.ItemCount || 0
            );

            const item = document.createElement("sp-menu-item");

            item.value = batchId;

            item.dataset.batchId = batchId;
            item.dataset.productType = productType;
            item.dataset.itemCount = itemCount;

            item.textContent =
                `${batchId} | ` +
                `${productType} | ` +
                `${itemCount} items`;

            menu.appendChild(item);
        }

        // Let sp-picker observe the changed option list.
        await new Promise(resolve => requestAnimationFrame(resolve));

        if (batches.length > 0) {
            const firstBatchId = String(
                batches[0].batchId || batches[0].BatchId
            );

            const firstItem = Array.from(
                menu.querySelectorAll("sp-menu-item")
            ).find(item => item.value === firstBatchId);

            if (firstItem) {
                firstItem.selected = true;
                firstItem.setAttribute("selected", "");
            }

            picker.value = firstBatchId;
        } else {
            picker.value = "";
            picker.removeAttribute("value");
        }

        await handleBatchSelectionChanged();
    }

    async function updatePsdSourceButtons() {
        const source = getSelectedPsdSource();

        console.log("Selected PSD source:", source);

        loadPsdFromDb.disabled = source !== "db";
        loadPsdFromJson.disabled = source !== "json";

        psdDropdown.value = "";
        psdToOpen.disabled = true;

        await refreshPsdRootFolderStatus();

        if (source === "db") {
            const productType = getSelectedProductType();

            console.log(
                "Loading PSD records from DB for product type:",
                productType
            );

            await populatePSDDropdownFromDB(productType);
        }
    }
    function refreshUiState() {
        updateBatchSummary();
        updatePSDOpenButton();
        updateRunButtonState();
    }
    loadPsdFromDb.addEventListener("click", async () => {
        const productTypeElement =
            document.getElementById("selectedProductType");

        const selectedProductType =
            productTypeElement?.textContent?.trim();

        const productType =
            selectedProductType &&
                selectedProductType !== "Unknown"
                ? selectedProductType
                : null;

        await populatePSDDropdownFromDB(productType);
        refreshUiState();
    });

    loadPsdFromJson.addEventListener("click", async () => {
        await populatePSDDropdownFromJsonFile();
        refreshUiState();
    });


    psdDropdown.addEventListener("change", () => {
        generationCompleted = false;
        refreshUiState();
    });

    psdToOpen.addEventListener("click", async () => {
        console.log("Open Template button clicked.");

        try {
            const selectedPath =
                getPickerValue(psdDropdown);

            console.log(
                "Selected PSD path:",
                selectedPath
            );

            if (!selectedPath) {
                await app.showAlert(
                    "Please select a PSD first."
                );
                return;
            }

            await openPSDFromRoot(selectedPath);

            if (app.activeDocument) {
                runBatchButton.disabled = false;
            }
        } catch (err) {
            console.error("PSD open failed:", err);
            console.error(err?.stack);

            await app.showAlert(
                `PSD open failed:\n${err.message}`
            );
        }
    });

    runBatchButton.addEventListener("click", async () => {
        if (isGenerating) {
            console.log(
                "Generate request ignored because generation is already running."
            );
            return;
        }

        isGenerating = true;
        generationCompleted = false;
        refreshUiState();

        try {
            await runBatchMockupGeneration();

            generationCompleted = true;

            if (getSelectedPhraseSource() === "db") {
                await populatePendingBatches();
            }
        } catch (error) {
            console.error("Mockup generation failed:", error);

            generationStatus.textContent =
                error?.message || "Generation failed";
        } finally {
            isGenerating = false;
            refreshUiState();
        }
    });

    if (loadPendingBatchesButton) {
        console.log("Refresh Queue button found.");

        loadPendingBatchesButton.addEventListener("click", async () => {
            console.log("Refresh Queue clicked.");
            await populatePendingBatches();
            refreshUiState();
        });
    } else {
        console.error("Could not find Refresh Queue button.");
    }

    await updatePsdSourceButtons();



    if (phraseSourceGroup) {
        phraseSourceGroup.addEventListener("change", async () => {

            console.log(
                "Phrase source changed to:",
                getSelectedPhraseSource()
            );


            await refreshFoldersForSelectedSource();

            if (getSelectedPhraseSource() === "db") {
                await populatePendingBatches();
            }
        });

        await refreshFoldersForSelectedSource();

        if (getSelectedPhraseSource() === "db") {
            await populatePendingBatches();
        }
    }

    if (toggleAdvancedButton && advancedPanel) {
        toggleAdvancedButton.addEventListener("click", () => {
            const isHidden = advancedPanel.style.display === "none";
            advancedPanel.style.display = isHidden ? "flex" : "none";
            toggleAdvancedButton.textContent = isHidden
                ? "Advanced / Settings ▲"
                : "Advanced / Settings ▼";
        });
    }
    refreshUiState();
});
async function uploadMockupFileToApi(
    fileEntry,
    batchId,
    productType,
    folderName
) {
    if (!fileEntry?.isFile) {
        throw new Error(
            "A mockup file entry is required for upload."
        );
    }

    const bytes =
        await fileEntry.read({
            format: storage.formats.binary
        });

    const remotePath =
        `${batchId}/` +
        `${productType}/` +
        `mockup_folders/` +
        `${encodeURIComponent(folderName)}/` +
        `${encodeURIComponent(fileEntry.name)}`;

    const url =
        `${CONFIG.PNG_API_BASE_URL}` +
        `${CONFIG.ENDPOINTS.FILE(remotePath)}`;

    console.log(
        `Uploading printable wall-art mockup: ${fileEntry.name}`
    );

    const response =
        await fetch(
            url,
            {
                method: "POST",
                headers: {
                    "Content-Type": "image/png"
                },
                body: bytes
            }
        );

    if (!response.ok) {
        const responseText =
            await response.text();

        throw new Error(
            `Failed to upload mockup ${fileEntry.name}: ` +
            `${response.status} ${responseText}`
        );
    }

    console.log(
        `Uploaded printable wall-art mockup: ${fileEntry.name}`
    );
}
async function uploadMockupFolderToApi(folder, batchId, productType, folderName) {
    const entries = await folder.getEntries();

    for (const entry of entries) {
        const fileName = entry.name.toLowerCase();

        const isFinalMockup =
            entry.isFile &&
            fileName.endsWith(".png") &&
            fileName.includes("-group.");

        if (!isFinalMockup) {
            continue;
        }
        console.log(`Uploading final mockup: ${entry.name}`);

        const bytes = await entry.read({ format: storage.formats.binary });

        const remotePath =
            `${batchId}/${productType}/mockup_folders/${encodeURIComponent(folderName)}/${encodeURIComponent(entry.name)}`;

        const url =
            `${CONFIG.PNG_API_BASE_URL}${CONFIG.ENDPOINTS.FILE(remotePath)}`;

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "image/png"
            },
            body: bytes
        });

        if (!response.ok) {
            throw new Error(`Failed to upload mockup ${entry.name}: ${response.status}`);
        }
    }
}
async function markMockupComplete(recordId) {
    if (!recordId) {
        throw new Error("Cannot mark mockup complete: missing record id.");
    }

    const url = `${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.MOCKUP_COMPLETE(encodeURIComponent(recordId))}`;

    const response = await fetch(url, {
        method: "POST"
    });

    if (!response.ok) {
        throw new Error(`Failed to mark mockup complete: ${response.status}`);
    }

    return await response.json();
}


function getPickerValue(picker) {
    if (!picker) {
        return "";
    }

    return picker.value || "";
}


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