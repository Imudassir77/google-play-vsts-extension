import * as fs from 'fs';
import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as glob from 'glob';

import * as googleutil from './googleutil';
import * as metadataHelper from './metadataHelper';

import * as googleapis from 'googleapis';
import { androidpublisher_v3 as pub3 } from 'googleapis';

async function run(): Promise<void> {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        tl.debug('Prepare task inputs.');

        // Authentication inputs

        const authType: string = tl.getInput('authType', true);
        let key: googleutil.ClientKey = {};
        if (authType === 'JsonFile') {
            const serviceAccountKeyFile: string = tl.getPathInput('serviceAccountKey', true, true);

            const stats: tl.FsStats = tl.stats(serviceAccountKeyFile);
            if (stats && stats.isFile()) {
                key = require(serviceAccountKeyFile);
            } else {
                tl.debug(`The service account file path ${serviceAccountKeyFile} points to a directory.`);
                throw new Error(tl.loc('InvalidAuthFile', serviceAccountKeyFile));
            }
        } else if (authType === 'ServiceEndpoint') {
            let serviceEndpoint: tl.EndpointAuthorization = tl.getEndpointAuthorization(tl.getInput('serviceEndpoint', true), false);
            key.client_email = serviceEndpoint.parameters['username'];
            key.private_key = serviceEndpoint.parameters['password'].replace(/\\n/g, '\n');
        }

        // General inputs

        const updateOnlyStoreListing: boolean = tl.getBoolInput('updateOnlyStoreListing', false);

        const packageName: string = tl.getInput('applicationId', true);
        tl.debug(`Application identifier: ${packageName}`);

        const mainBundlePattern: string = tl.getPathInput('bundleFile');
        tl.debug(`Main bundle pattern: ${mainBundlePattern}`);
        const additionalBundlePatterns: string[] = tl.getDelimitedInput('additionalBundles', '\n');
        tl.debug(`Additional bundle patterns: ${additionalBundlePatterns}`);

        const mainApkPattern: string = tl.getPathInput('apkFile');
        tl.debug(`Main apk pattern: ${mainApkPattern}`);
        const additionalApkPatterns: string[] = tl.getDelimitedInput('additionalApks', '\n');
        tl.debug(`Additional apk patterns: ${additionalApkPatterns}`);

        const mainBundleFile: string = getMainFilePath(mainBundlePattern);
        const additionalBundleFiles: string[] = getAdditionalFilesPaths(additionalBundlePatterns);

        const mainApkFile: string = getMainFilePath(mainApkPattern);
        const additionalApkFiles: string[] = getAdditionalFilesPaths(additionalApkPatterns);

        const shouldPickObbForMainApk: boolean = tl.getBoolInput('shouldPickObbFile', false);
        const shouldPickObbForAdditionalApks: boolean = tl.getBoolInput('shouldPickObbFile', false);

        if (shouldPickObbForMainApk && !mainApkFile) {
            throw new Error(tl.loc('MustProvideMainApkIfMainObb'));
        }
        if (shouldPickObbForAdditionalApks && additionalApkFiles.length === 0) {
            throw new Error(tl.loc('MustProvideAdditionalApkIfAdditionalObb'));
        }

        const bundleFileList: string[] = Array.from(new Set([mainBundleFile, ...additionalBundleFiles]));
        tl.debug(`Bundles: ${bundleFileList}`);
        const apkFileList: string[] = Array.from(new Set([mainApkFile, ...additionalApkFiles]));
        tl.debug(`APKs: ${apkFileList}`);

        const track: string = tl.getInput('track', true);

        const shouldAttachMetadata: boolean = tl.getBoolInput('shouldAttachMetadata', false);

        let changelogFile: string = null;
        let languageCode: string = null;
        let metadataRootPath: string = null;

        if (shouldAttachMetadata) {
            metadataRootPath = tl.getPathInput('metadataRootPath', true, true);
        } else {
            changelogFile = tl.getInput('changelogFile', false);
            languageCode = tl.getInput('languageCode', false) || 'en-US';
        }

        // Advanced inputs section

        const updatePrioritySupplied: boolean = tl.getBoolInput('changeUpdatePriority');
        const updatePriority: number = Number(updatePrioritySupplied ? tl.getInput('updatePriority', false) : 0);

        const userFractionSupplied: boolean = tl.getBoolInput('rolloutToUserFraction');
        const userFraction: number = Number(userFractionSupplied ? tl.getInput('userFraction', false) : 1.0);

        const uploadMappingFile: boolean = tl.getBoolInput('shouldUploadMappingFile', false);
        const mappingFilePattern: string = tl.getPathInput('mappingFilePath', false);

        const sendChangesToReview: boolean = tl.getBoolInput('changesNotSentForReview');

        const releaseName: string = tl.getInput('releaseName', false);

        const versionCodeFilterType: string = tl.getInput('versionCodeFilterType', false) || 'all';
        let versionCodeFilter: string | number[] = null;
        if (versionCodeFilterType === 'list') {
            versionCodeFilter = getVersionCodeListInput();
        } else if (versionCodeFilterType === 'expression') {
            versionCodeFilter = tl.getInput('replaceExpression', true);
        }

        // The regular submission process is composed
        // of a transction with the following steps:
        // -----------------------------------------
        // #1) Get an OAuth token by authentincating the service account
        // #2) Create a new editing transaction
        // #3) Upload the new APK(s) or AAB(s)
        // #4) Specify the track that should be used for the new APK/AAB (e.g. alpha, beta)
        // #5) Specify the new change log
        // #6) Commit the edit transaction

        const globalParams: googleapis.Common.GlobalOptions = { auth: null, params: {} };

        googleutil.updateGlobalParams(globalParams, 'packageName', packageName);

        tl.debug('Initializing JWT.');
        const jwtClient: googleapis.Common.JWT = googleutil.getJWT(key);
        globalParams.auth = jwtClient;

        tl.debug('Initializing Google Play publisher API.');
        const edits: pub3.Resource$Edits = googleutil.publisher.edits;

        tl.debug('Authorize JWT.');
        await jwtClient.authorize();

        console.log(tl.loc('GetNewEditAfterAuth'));
        tl.debug('Creating a new edit transaction in Google Play.');
        const edit: pub3.Schema$AppEdit = await googleutil.getNewEdit(edits, packageName);
        googleutil.updateGlobalParams(globalParams, 'editId', edit.id);

        let requireTrackUpdate = false;
        const versionCodes: number[] = [];

        if (updateOnlyStoreListing) {
            tl.debug('Selected store listing update only -> skip APK/AAB reading');
        } else {
            tl.debug(`Uploading ${apkFileList.length} APK(s) and ${bundleFileList} AAB(s).`);
            requireTrackUpdate = true;

            for (const apkFile of apkFileList) {
                tl.debug(`Uploading APK ${apkFile}`);
                const apk: pub3.Schema$Apk = await googleutil.addApk(edits, packageName, apkFile);
                tl.debug(`Uploaded ${apkFile} with the version code ${apk.versionCode}`);
                if (
                    shouldPickObbForApk(apkFile, mainApkFile, shouldPickObbForMainApk, shouldPickObbForAdditionalApks)
                    && getObbFile(apkFile, packageName, apk.versionCode) !== null
                ) {
                    const obb: pub3.Schema$ExpansionFilesUploadResponse = await googleutil.addObb(
                        edits,
                        packageName,
                        getObbFile(apkFile, packageName, apk.versionCode),
                        apk.versionCode,
                        'main'
                    );

                    if (obb.expansionFile.fileSize !== null && Number(obb.expansionFile.fileSize) !== 0) {
                        console.log(`Uploaded Obb file with version code ${apk.versionCode} and size ${obb.expansionFile.fileSize}`);
                    }
                }
                versionCodes.push(apk.versionCode);
            }

            for (const bundleFile of bundleFileList) {
                tl.debug(`Uploading bundle ${bundleFile}`);
                const bundle: pub3.Schema$Bundle = await googleutil.addBundle(edits, packageName, bundleFile);
                tl.debug(`Uploaded ${bundleFile} with the version code ${bundle.versionCode}`);
                versionCodes.push(bundle.versionCode);
            }

            if (versionCodes.length > 0 && uploadMappingFile) {
                tl.debug(`Mapping file pattern: ${mappingFilePattern}`);

                const mappingFilePath = resolveGlobPath(mappingFilePattern);
                tl.checkPath(mappingFilePath, 'mappingFilePath');
                console.log(tl.loc('FoundDeobfuscationFile', mappingFilePath));
                tl.debug(`Uploading mapping file ${mappingFilePath}`);
                await googleutil.uploadDeobfuscation(edits, mappingFilePath, packageName, versionCodes[0]);
                tl.debug(`Uploaded ${mappingFilePath} for APK ${mainApkFile}`);
            }
        }

        let releaseNotes: googleapis.androidpublisher_v3.Schema$LocalizedText[];
        if (shouldAttachMetadata) {
            console.log(tl.loc('AttachingMetadataToRelease'));
            tl.debug(`Uploading metadata from ${metadataRootPath}`);
            releaseNotes = await metadataHelper.addMetadata(edits, versionCodes.map((versionCode) => Number(versionCode)), metadataRootPath);
            if (updateOnlyStoreListing) {
                tl.debug('Selected store listing update -> skip update track');
            }
            requireTrackUpdate = !updateOnlyStoreListing;
        } else if (changelogFile) {
            tl.debug(`Uploading the common change log ${changelogFile} to all versions`);
            const commonNotes = await metadataHelper.getCommonReleaseNotes(languageCode, changelogFile);
            releaseNotes = commonNotes && [commonNotes];
            requireTrackUpdate = true;
        }

        if (requireTrackUpdate) {
            console.log(tl.loc('UpdateTrack'));
            tl.debug(`Updating the track ${track}.`);
            const updatedTrack: pub3.Schema$Track = await updateTrack(
                edits,
                packageName,
                track,
                versionCodes,
                versionCodeFilterType,
                versionCodeFilter,
                userFraction,
                updatePriority,
                releaseNotes,
                releaseName
            );
            tl.debug('Updated track info: ' + JSON.stringify(updatedTrack));
        }

        tl.debug('Committing the edit transaction in Google Play.');
        await edits.commit({ changesNotSentForReview: sendChangesToReview });

        console.log(tl.loc('AptPublishSucceed'));
        console.log(tl.loc('TrackInfo', track));
        tl.setResult(tl.TaskResult.Succeeded, tl.loc('Success'));
    } catch (e) {
        tl.setResult(tl.TaskResult.Failed, e);
    }
}

/**
 * Update a given release track with the given information
 * Assumes authorized
 * @param packageName unique android package name (com.android.etc)
 * @param track one of the values {"internal", "alpha", "beta", "production"}
 * @param bundleVersionCode version code of uploaded modules.
 * @param versionCodeFilterType type of version code replacement filter, i.e. 'all', 'list', or 'expression'
 * @param versionCodeFilter version code filter, i.e. either a list of version code or a regular expression string.
 * @param userFraction the fraction of users to get update
 * @param updatePriority - In-app update priority value of the release. All newly added APKs in the release will be considered at this priority. Can take values in the range [0, 5], with 5 the highest priority. Defaults to 0.
 * @returns track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
async function updateTrack(
    edits: pub3.Resource$Edits,
    packageName: string,
    track: string,
    versionCodes: number[],
    versionCodeFilterType: string,
    versionCodeFilter: string | number[],
    userFraction: number,
    updatePriority: number,
    releaseNotes?: pub3.Schema$LocalizedText[],
    releaseName?: string
): Promise<pub3.Schema$Track> {

    let newTrackVersionCodes: number[] = [];
    let res: pub3.Schema$Track;

    if (versionCodeFilterType === 'all') {
        newTrackVersionCodes = versionCodes;
    } else {
        try {
            res = await googleutil.getTrack(edits, packageName, track);
        } catch (e) {
            tl.debug(`Failed to download track ${track} information.`);
            tl.debug(e);
            throw new Error(tl.loc('CannotDownloadTrack', track, e));
        }

        const oldTrackVersionCodes: number[] = res.releases[0].versionCodes.map((v) => Number(v));
        tl.debug('Current version codes: ' + JSON.stringify(oldTrackVersionCodes));

        if (typeof(versionCodeFilter) === 'string') {
            tl.debug(`Removing version codes matching the regular expression: ^${versionCodeFilter as string}$`);
            const versionCodesToRemove: RegExp = new RegExp(`^${versionCodeFilter as string}$`);

            oldTrackVersionCodes.forEach((versionCode) => {
                if (!versionCode.toString().match(versionCodesToRemove)) {
                    newTrackVersionCodes.push(versionCode);
                }
            });
        } else {
            const versionCodesToRemove = versionCodeFilter as number[];
            tl.debug('Removing version codes: ' + JSON.stringify(versionCodesToRemove));

            oldTrackVersionCodes.forEach((versionCode) => {
                if (versionCodesToRemove.indexOf(versionCode) === -1) {
                    newTrackVersionCodes.push(versionCode);
                }
            });
        }

        tl.debug('Version codes to keep: ' + JSON.stringify(newTrackVersionCodes));
        versionCodes.forEach((versionCode) => {
            if (newTrackVersionCodes.indexOf(versionCode) === -1) {
                newTrackVersionCodes.push(versionCode);
            }
        });
    }

    tl.debug(`New ${track} track version codes: ` + JSON.stringify(newTrackVersionCodes));
    try {
        res = await googleutil.updateTrack(edits, packageName, track, newTrackVersionCodes, userFraction, updatePriority, releaseNotes, releaseName);
    } catch (e) {
        tl.debug(`Failed to update track ${track}.`);
        tl.debug(e);
        throw new Error(tl.loc('CannotUpdateTrack', track, e));
    }
    return res;
}

function getMainFilePath(mainPattern: string): string {
    if (!mainPattern) {
        return null;
    }

    return resolveGlobPath(mainPattern);
}

function getAdditionalFilesPaths(additionalPatterns: string[]): string[] {
    if (!additionalPatterns || additionalPatterns.length === 0) {
        return [];
    }

    const paths = new Set<string>();

    for (const additionalPattern of additionalPatterns) {
        resolveGlobPaths(additionalPattern).forEach((path) => paths.add(path));
    }

    return Array.from(paths);
}

/**
 * @param mainPattern main file pattern; picks up a single file
 * @param additionalFilesPatterns additional files patterns; may pick up multiple files for each pattern
 * @returns All resolved file paths
 */
function getPaths(mainPattern: string, additionalFilesPatterns: string[]): string[] {
    const paths = new Set<string>();

    if (mainPattern) {
        paths.add(resolveGlobPath(mainPattern));
    }

    if (additionalFilesPatterns && additionalFilesPatterns.length > 0) {
        for (const additionalPattern of additionalFilesPatterns) {
            resolveGlobPaths(additionalPattern).forEach((path) => paths.add(path));
        }
    }

    return Array.from(paths);
}

/**
 * Get the appropriate file from the provided pattern
 * @param path The minimatch pattern of glob to be resolved to file path
 * @returns path path of the file resolved by glob. Returns null if not found or if `path` argument was not provided
 */
function resolveGlobPath(path: string): string {
    if (path) {
        // VSTS tries to be smart when passing in paths with spaces in them by quoting the whole path. Unfortunately, this actually breaks everything, so remove them here.
        path = path.replace(/\"/g, '');

        const filesList: string[] = glob.sync(path);
        if (filesList.length > 0) {
            return filesList[0];
        }

        return null;
    }

    return null;
}

/**
 * Get the appropriate files from the provided pattern
 * @param path The minimatch pattern of glob to be resolved to file path
 * @returns paths of the files resolved by glob
 */
 function resolveGlobPaths(path: string): string[] {
    if (path) {
        // Convert the path pattern to a rooted one. We do this to mimic for string inputs the behaviour of filePath inputs provided by Build Agent.
        path = tl.resolve(tl.getVariable('System.DefaultWorkingDirectory'), path);

        let filesList: string[] = glob.sync(path);
        tl.debug(`Additional paths: ${JSON.stringify(filesList)}`);

        return filesList;
    }

    return [];
}

function getVersionCodeListInput(): number[] {
    const versionCodeFilterInput: string[] = tl.getDelimitedInput('replaceList', ',', false);
    const versionCodeFilter: number[] = [];
    const incorrectCodes: string[] = [];

    for (const versionCode of versionCodeFilterInput) {
        const versionCodeNumber: number = parseInt(versionCode.trim(), 10);

        if (versionCodeNumber && (versionCodeNumber > 0)) {
            versionCodeFilter.push(versionCodeNumber);
        } else {
            incorrectCodes.push(versionCode.trim());
        }
    }

    if (incorrectCodes.length > 0) {
        throw new Error(tl.loc('IncorrectVersionCodeFilter', JSON.stringify(incorrectCodes)));
    } else {
        return versionCodeFilter;
    }
}

function shouldPickObbForApk(apk: string, mainApk: string, shouldPickObbFile: boolean, shouldPickObbFileForAdditonalApks: boolean): boolean {
    if ((apk === mainApk) && shouldPickObbFile) {
        return true;
    } else if ((apk !== mainApk) && shouldPickObbFileForAdditonalApks) {
        return true;
    }
    return false;
}

/**
 * Get obb file. Returns any file with .obb extension if present in parent directory else returns
 * from apk directory with pattern: main.<versionCode>.<packageName>.obb
 * @param apkPath apk file path
 * @param packageName package name of the apk
 * @param versionCode version code of the apk
 * @returns ObbPathFile of the obb file if present else null
 */
function getObbFile(apkPath: string, packageName: string, versionCode: number): string {
    const currentDirectory: string = path.dirname(apkPath);
    const parentDirectory: string = path.dirname(currentDirectory);

    const fileNamesInParentDirectory: string[] = fs.readdirSync(parentDirectory);
    const obbPathFileInParent: string | undefined = fileNamesInParentDirectory.find(file => path.extname(file) === '.obb');

    if (obbPathFileInParent) {
        tl.debug(`Found Obb file for upload in parent directory: ${obbPathFileInParent}`);
        return path.join(parentDirectory, obbPathFileInParent);
    }

    const fileNamesInApkDirectory: string[] = fs.readdirSync(currentDirectory);
    const expectedMainObbFile: string = `main.${versionCode}.${packageName}.obb`;
    const obbPathFileInCurrent: string | undefined = fileNamesInApkDirectory.find(file => file.toString() === expectedMainObbFile);

    if (obbPathFileInCurrent) {
        tl.debug(`Found Obb file for upload in current directory: ${obbPathFileInCurrent}`);
        return path.join(currentDirectory, obbPathFileInCurrent);
    } else {
        tl.debug(`No Obb found for ${apkPath}, skipping upload`);
    }

    return obbPathFileInCurrent;
}

run();