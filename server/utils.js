const { app } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// const log = require('./logger').GetLogger('Utils');

exports.GetUserAgent = () => `CVRX/${app.getVersion()} (deployment:${app.isPackaged ? 'production' : 'development'})`;

// Checks if ChilloutVR.exe process is currently running
// Returns: True if ChilloutVR.exe is running, false otherwise
exports.IsChilloutVRRunning = async () => {
    try {
        const platform = process.platform;
        
        if (platform === 'win32') {
            // Windows: Use tasklist command to check for ChilloutVR.exe
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq ChilloutVR.exe" /FO CSV /NH');
            // If the process is running, stdout will contain the process info
            // If not running, stdout will be empty or contain "INFO: No tasks are running..."
            return stdout.includes('ChilloutVR.exe');
        } else if (platform === 'darwin') {
            // macOS: Use ps command to check for ChilloutVR process
            const { stdout } = await execAsync('ps aux | grep -i chilloutvr | grep -v grep');
            return stdout.trim().length > 0;
        } else if (platform === 'linux') {
            // Linux: Use ps command to check for ChilloutVR process
            const { stdout } = await execAsync('ps aux | grep -i chilloutvr | grep -v grep');
            return stdout.trim().length > 0;
        } else {
            // Unsupported platform, assume not running
            return false;
        }
    } catch (error) {
        // If there's an error executing the command, assume the process is not running
        // This could happen if the command fails or if there are permission issues
        return false;
    }
};

// Deep clones an object using JSON methods.
// This approach works for plain objects without circular references.
// obj - The object to be cloned.
// Returns: The deep cloned object.
exports.DeepClone = (obj) => {
    return JSON.parse(JSON.stringify(obj));
};

const htmlEscapeMap = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#039;',
});

// Escape the five HTML-significant characters in a string so it renders as
// literal text when injected into innerHTML. Anything user-controlled coming
// off the wire goes through this so it can't smuggle markup into the renderer.
const EscapeStringFromHtml = (text) => text.replace(/[&<>"']/g, (m) => htmlEscapeMap[m]);
exports.EscapeStringFromHtml = EscapeStringFromHtml;

// Recursively escape every string field in an object/array. Returns a new
// (deep-cloned) value; the input is left untouched. Pass a primitive string
// directly and you get the escaped string back.
exports.EscapeHtml = function EscapeHtml(obj, firstIteration = true) {
    if (typeof obj === 'string') return EscapeStringFromHtml(obj);
    if (obj) {
        // Deep clone on entry to prevent mutating the caller's object (some are cached).
        if (firstIteration) obj = exports.DeepClone(obj);
        for (let key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            // Note: Array also shows as object
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                exports.EscapeHtml(obj[key], false);
            } else if (Object.prototype.toString.call(obj[key]) === '[object String]') {
                obj[key] = EscapeStringFromHtml(obj[key]);
            }
        }
    }
    return obj;
};

// Renames properties of an entity based on a given mapping.
// entity - The object to rename properties for.
// mapping - An object where keys are api property names and values are our property names.
// Returns: The entity with renamed properties.
exports.MapEntity = (entity, mapping) => {

    // If it's an array, handle each entity separately
    if (Array.isArray(entity)) {
        const result = [];
        for (const entityElement of entity) {
            result.push(exports.MapEntity(entityElement, mapping));
        }
        return result;
    }

    const entityToMap = { ...entity };

    for (let apiKey in mapping) {
        if (Object.prototype.hasOwnProperty.call(entityToMap, apiKey)) {
            const ourKey = mapping[apiKey];
            // If the mapping is an object, it means it's a nested mapping
            if (typeof ourKey === 'object' && ourKey !== null) {
                const entityValue = entityToMap[apiKey];
                // If it's an object and not null or is an array, use the object/array mapping
                if (typeof entityValue === 'object' && entityValue !== null || Array.isArray(entityValue)) {
                    entityToMap[ourKey.root] = exports.MapEntity(entityValue, ourKey.mapping);
                }
                // If it's a primitive or null just set the value
                else {
                    entityToMap[ourKey.root] = entityValue;
                }
            }
            // Otherwise let's just fix the key
            else {
                entityToMap[ourKey] = entityToMap[apiKey];
            }
            delete entityToMap[apiKey];
        }
    }

    return entityToMap;
};
