const path = require('path');
const axios = require('axios');
const fs = require('fs');

const {app, dialog, shell} = require('electron');
const {pipeline} = require('stream/promises');

const Config = require('./config');
const NotificationHelper = require('./notification-helper');
const log = require('./logger').GetLogger('Updater');

const AppDataPath = app.getPath('userData');
const UpdaterPath = path.join(AppDataPath, 'CVRUpdater');

const windowsPlatform = 'win32';
const latestRelease = 'https://api.github.com/repos/AstroDogeDX/CVRX/releases/latest';

// Per-platform asset preferences. The picker walks the array in order and
// returns the first asset whose name ends with one of the listed extensions.
// Windows can auto-install the Squirrel .exe; everything else just gets a
// "open in browser" link to the release asset (or the release page itself
// if no preferred asset exists).
const platformAssetExtensions = {
    'win32': ['.exe'],
    'darwin': ['.dmg'],
    // Linux: prefer AppImage (universal), then deb, then rpm.
    'linux': ['.AppImage', '.deb', '.rpm'],
};

function pickAssetForPlatform(assets) {
    const exts = platformAssetExtensions[process.platform] || [];
    for (const ext of exts) {
        const match = assets.find(a => a.name.toLowerCase().endsWith(ext.toLowerCase()));
        if (match) return match;
    }
    return null;
}

const currentVersion = `v${app.getVersion()}`;

const checkUpdatesIntervalMinutes = 15;
const activelyCheckRateLimit = 2 * 60 * 1000;

let ignoredForNow = false;
let dialogOpened = false;
let activelyCheckForUpdatesTimeout = null;
let mainWindowRef = null; // Add reference to main window for progress events
let isInstallingUpdate = false; // Flag to track if update installation is in progress

exports.Setup = async (mainWindow) => {
    // Store reference to main window for progress events
    mainWindowRef = mainWindow;

    // Ensure we have the directory created
    await fs.promises.mkdir(UpdaterPath, {recursive: true});

    // Reset dialog state on startup to ensure clean state
    dialogOpened = false;
    ignoredForNow = false;

    // Clear installer filers
    for (const fileName of await fs.promises.readdir(UpdaterPath)) {
        if (!fileName.endsWith('.exe')) continue;
        const filePath = path.join(UpdaterPath, fileName);
        log.info(`[ClearInstallerFiles] Clearing previous update file: ${filePath}`);
        await fs.promises.unlink(filePath);
    }

    // Run initial update check on startup
    log.info('[Setup] Running initial update check on startup...');
    try {
        await exports.CheckLatestRelease(mainWindow, false);
    } catch (error) {
        log.error('[Setup] Initial update check failed:', error.toString());
    }

    // Set up recurring update checks every 15 minutes
    setInterval(async () => {
        try {
            await exports.CheckLatestRelease(mainWindow);
        } catch (error) {
            // It's ok to only log here since a new call will be made in 15 minutes
            log.error('[CRON CheckLatestRelease] Failed to check for new releases:', error.toString());
        }
    }, checkUpdatesIntervalMinutes * 60 * 1000);
};

exports.CheckLatestRelease = async (mainWindow, bypassIgnores = false) => {

    if (bypassIgnores) {
        if (activelyCheckForUpdatesTimeout && activelyCheckForUpdatesTimeout > Date.now()) {
            const msg = `Manually checked for updates too recently.
            You can try again in: ${(activelyCheckForUpdatesTimeout - Date.now()) / 1000} seconds.`;
            log.info(`[CheckLatestRelease] ${msg}`);
            return { hasUpdates: null, msg: msg };
        }
        activelyCheckForUpdatesTimeout = Date.now() + activelyCheckRateLimit;
    }

    if (dialogOpened) {
        const msg = 'Skipping because the previous dialog is still open';
        log.info(`[CheckLatestRelease] ${msg}`);
        return { hasUpdates: null, msg: msg };
    }

    if (!bypassIgnores && ignoredForNow) {
        const msg = 'Skipping check since user requested to ignore...';
        log.info(`[CheckLatestRelease] ${msg}`);
        return { hasUpdates: null, msg: msg };
    }

    try {
        log.info('[CheckLatestRelease] Checking for updates...');

        const {data} = await axios.get(latestRelease);
        const tagName = data.tag_name;

        if (tagName !== currentVersion) {
            log.warn(`[CheckLatestRelease] There is a new version available (${tagName}), installed version: ${currentVersion}`);
        }
        else {
            const msg = `You have the current latest version: ${tagName}!`;
            log.info(`[CheckLatestRelease] ${msg}`);
            return { hasUpdates: false, msg: msg };
        }

        const ignoredVersion = Config.GetUpdaterIgnoreVersion();
        log.debug(`[CheckLatestRelease] Current version: ${currentVersion}, Latest version: ${tagName}, Ignored version: ${ignoredVersion}`);
        if (!bypassIgnores && ignoredVersion && tagName === ignoredVersion) {
            const msg = `Ignoring ${tagName} because you chose to skip it...`;
            log.info(`[CheckLatestRelease] ${msg}`);
            return { hasUpdates: true, msg: msg };
        }

        // Pick the best asset for this platform. If we can't find one (e.g.
        // a release missing the platform's installer), fall back to opening
        // the release page so the user can pick something themselves.
        const asset = pickAssetForPlatform(data.assets || []);
        const isWindows = process.platform === windowsPlatform;
        const autoInstall = isWindows && !!asset;

        const changeLogs = data.body;
        const updateInfo = {
            tagName,
            changeLogs,
            downloadUrl: asset ? asset.browser_download_url : data.html_url,
            fileName: asset ? asset.name : null,
            autoInstall,
        };

        if (!asset) {
            log.warn(`[CheckLatestRelease] No matching asset found for ${process.platform} in release ${tagName}; will link to the release page.`);
        }

        // Show the update modal/notification on automatic checks.
        if (!bypassIgnores && mainWindow && mainWindow.webContents) {
            dialogOpened = true;
            log.info(`[CheckLatestRelease] Automatically showing update modal for version ${tagName} (autoInstall=${autoInstall})`);
            try {
                mainWindow.webContents.send('update-available', updateInfo);
                await NotificationHelper.showUpdateNotification({
                    version: tagName,
                    changeLogs,
                    downloadUrl: updateInfo.downloadUrl,
                    fileName: updateInfo.fileName,
                });
                log.info(`[CheckLatestRelease] Sent custom notification for update ${tagName}`);
            } catch (sendError) {
                log.error(`[CheckLatestRelease] Failed to send update-available event: ${sendError}`);
                dialogOpened = false;
            }
        }

        return {
            hasUpdates: true,
            msg: `A new version (${tagName}) is available!`,
            updateInfo,
        };
    } catch (error) {
        dialogOpened = false;
        log.error(`[CheckLatestRelease] [Error] ${latestRelease}`, error.toString());
        throw new Error(`Error: ${error.toString()}`);
    }
};

// Handle update actions from the frontend
exports.HandleUpdateAction = async (action, updateInfo) => {
    try {
        switch (action) {
            case 'download':
                // Only Windows can self-install. For everything else, open the
                // release page (or direct asset link) in the user's browser
                // so they can grab the installer themselves.
                if (updateInfo.autoInstall) {
                    await DownloadFile(updateInfo.downloadUrl, updateInfo.fileName);
                } else {
                    log.info(`[HandleUpdateAction] Opening update URL in browser: ${updateInfo.downloadUrl}`);
                    await shell.openExternal(updateInfo.downloadUrl);
                }
                break;
            case 'askLater':
                // Clear ignore version setting
                await Config.SetUpdaterIgnoreVersion(null);
                break;
            case 'ignore':
                // Mark as ignored, we won't bother the user again until next launch
                ignoredForNow = true;
                // Clear ignore version setting
                await Config.SetUpdaterIgnoreVersion(null);
                break;
            case 'skip':
                // Mark to skip this version
                await Config.SetUpdaterIgnoreVersion(updateInfo.tagName);
                break;
            default:
                throw new Error(`Unknown update action: ${action}`);
        }
    } finally {
        // Reset dialog opened flag so future checks can show the modal
        dialogOpened = false;
    }
};

async function DownloadFile(assetUrl, assetName) {

    // We're only supporting auto update on Windows
    if (process.platform !== windowsPlatform) {
        log.error(`[DownloadFile] We only support auto-updating on Windows, your current platform: ${process.platform}`);
        return;
    }

    await fs.promises.mkdir(UpdaterPath, {recursive: true});
    log.info(`[DownloadFile] Downloading ${assetUrl} to ${UpdaterPath}...`);
    
    // Show download progress modal
    if (mainWindowRef && mainWindowRef.webContents) {
        mainWindowRef.webContents.send('update-download-started', { fileName: assetName });
    }
    
    const response = await axios.get(assetUrl, {responseType: 'stream'});
    const filepath = path.join(UpdaterPath, assetName);
    
    // Get total file size from response headers
    const totalSize = parseInt(response.headers['content-length'], 10);
    let downloadedSize = 0;
    
    const writeStream = fs.createWriteStream(filepath);
    
    // Track download progress
    response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const progress = totalSize ? (downloadedSize / totalSize) * 100 : 0;
        
        // Send progress update to frontend
        if (mainWindowRef && mainWindowRef.webContents) {
            mainWindowRef.webContents.send('update-download-progress', {
                downloadedSize,
                totalSize,
                progress,
                fileName: assetName
            });
        }
    });
    
    // Use pipeline for streaming download with progress tracking
    await pipeline(response.data, writeStream);
    
    log.info(`[DownloadFile] Finished downloading to: ${filepath}`);
    
    // Send download complete event
    if (mainWindowRef && mainWindowRef.webContents) {
        mainWindowRef.webContents.send('update-download-complete', { fileName: assetName });
    }

    await InstallLatestRelease(assetName);
}

async function InstallLatestRelease(assetName) {

    // We're only supporting auto update on Windows
    if (process.platform !== windowsPlatform) {
        log.error(`[InstallLatestRelease] We only support auto-updating on Windows, your current platform: ${process.platform}`);
        return;
    }

    const filepath = path.join(UpdaterPath, assetName);
    log.info(`[InstallLatestRelease] Quitting and installing: ${filepath}`);
    
    // Set the flag to indicate update installation is in progress
    isInstallingUpdate = true;
    
    app.relaunch({execPath: filepath});
    app.quit();
}

// Export function to check if update installation is in progress
exports.IsInstallingUpdate = () => isInstallingUpdate;
