import * as core from '@actions/core';
import { WebRequest, WebRequestOptions, WebResponse, sendRequest } from "./client";
import * as querystring from 'querystring';

import { v4 as uuidv4 } from 'uuid';
import { GitHubClient } from './gitClient';
import * as fs from 'fs';

let conclusion = "Healthy";

interface Details {
    description: string;
    remediationSteps: string;
    title: string;
}


function getAzureAccessToken(servicePrincipalId, servicePrincipalKey, tenantId, authorityUrl): Promise<string> {

    if (!servicePrincipalId || !servicePrincipalKey || !tenantId || !authorityUrl) {
        throw new Error("Not all values are present in the creds object. Ensure appId, password and tenant are supplied");
    }
    return new Promise<string>((resolve, reject) => {
        let webRequest = new WebRequest();
        webRequest.method = "POST";
        webRequest.uri = `${authorityUrl}/${tenantId}/oauth2/token/`;
        webRequest.body = querystring.stringify({
            resource: 'https://management.azure.com',
            client_id: servicePrincipalId,
            grant_type: "client_credentials",
            client_secret: servicePrincipalKey
        });
        webRequest.headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
        };

        let webRequestOptions: WebRequestOptions = {
            retriableStatusCodes: [400, 408, 409, 500, 502, 503, 504],
        };

        sendRequest(webRequest, webRequestOptions).then(
            (response: WebResponse) => {
                if (response.statusCode == 200) {
                    resolve(response.body.access_token);
                }
                else if ([400, 401, 403].indexOf(response.statusCode) != -1) {
                    reject('ExpiredServicePrincipal');
                }
                else {
                    reject('CouldNotFetchAccessTokenforAzureStatusCode');
                }
            },
            (error) => {
                reject(error)
            }
        );
    });
}

async function getContainerScanDetails() {
    const commit = core.getInput('commit-id');
    const commitId = commit ? commit : process.env['GITHUB_SHA'];
    const token = core.getInput('token');
    const client = new GitHubClient(process.env['GITHUB_REPOSITORY'], token);
    const runs = await client.getCheckRuns(commitId);

    if (!runs || runs.length == 1) return "";

    let details = "";
    let checkRuns = runs['check_runs'];
    checkRuns.forEach((run: any) => {
        if (run && run.name && run.name.indexOf('[container-scan]') >= 0) {
            console.log(`Found container scan result: ${run.name}`);
            details = `
            ${details} 
            The check-run can be found <a href="${run.html_url}"> here </a>
            ${run.output.text.replace(/\*\*/g, "")}`;
            if (run.conclusion === 'failure' && conclusion === 'Healthy') {
                conclusion = 'Unhealthy';
            }
        }
    });

    return `${details.trim()}`;
}

function getContents(content: any) {
    let summary = "";
    if (content && content["runs"]) {
        let runs: any [] = content["runs"];
        runs.forEach((run) => {
            if (run["results"] && run["results"].length > 0) {
                let results: any[] = run["results"];
                results.forEach((result) => {
                    if (result && result["message"] && result["message"]["text"]) {
                        if (summary) {
                            summary = `${summary} \n ----------------- \n ${result["message"]["text"]}`
                        }
                        else {
                            summary = result["message"]["text"];
                        }
                    }

                });
            }
        });
    }
    return summary;
}

function summariseSarif(sarifFile: string): string {

    if (fs.existsSync(sarifFile)) {
        const contents = fs.readFileSync(sarifFile).toString();
        try {
            let sarif = JSON.parse(contents);
            return getContents(sarif);
        } catch (ex) {
            console.log(ex);
            return '';
        }
    }
    else {
        console.log('File not found:', sarifFile)
        return "";
    }
}

async function getDetails() {
    const run_id = process.env['GITHUB_RUN_ID'];
    const workflow = process.env['GITHUB_WORKFLOW'];
    const repo = process.env['GITHUB_REPOSITORY'];
    const run_url = `https://github.com/${repo}/actions/runs/${run_id}?check_suite_focus=true`;
    const workflow_url = `https://github.com/${repo}/actions?query=workflow%3A${workflow}`;

    const containerScanResult = await getContainerScanDetails();

    let description = "";

    let sarifFile = core.getInput('upload-sarif');
    if (sarifFile) {
        const details: Details = {
            remediationSteps: `${summariseSarif(sarifFile)} \n `,
            description: `Results of running the Github container scanning action on the image deployed to this cluster. 
            You can find <a href="${workflow_url}">the workflow here</a>.
            This assessment was created from <a href="${run_url}">this workflow run</a>.`,
            title: "Github container scanning for deployed container images"
        };
        return details;
    }

    if (containerScanResult.trim()) {
        description = `
        Results of running the Github container scanning action on the image deployed to this cluster. 
        You can find <a href="${workflow_url}">the workflow here</a>.
        This assessment was created from <a href="${run_url}">this workflow run</a>.`
        const details: Details = {
            remediationSteps: `${containerScanResult} \n 
            <b>Steps to remediate:</b>
            If possible, update base images to a version that addresses these vulnerabilities.
            If the vulnerabilities are known and acceptable, add them to the allowed list in the Github repo.`,
            description: description,
            title: "Github container scanning for deployed container images"
        };
        return details;
    }

    return {
        description: `
        This security assessment has been created from GitHub actions workflow.

        You can find <a href="${workflow_url}">the workflow here</a>.
        This assessment was created from <a href="${run_url}">this workflow run</a>.

        For mitigation take appropriate steps.`,
        remediationSteps: "You can do it yourself",
        title: "Assessment from github"
    } as Details;
}


function getAssessmentName(details: Details) {
    const run_id = process.env['GITHUB_RUN_ID'];
    const workflow = process.env['GITHUB_WORKFLOW'];
    const title = core.getInput('assessment-title')
    if (title && title.trim())
        details.title = title;

    if (details.title) {
        return `${details.title} - ${workflow} - ${run_id}`
    }
    return `Assessment from GitHub Action - ${workflow} - ${run_id}`;
}

function createAssessmentMetadata(azureSessionToken: string, subscriptionId: string, managementEndpointUrl: string, metadata_guid: string, details: Details): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        console.log("Creating Metadata")
        let severity = core.getInput('severity', { required: true });
        var webRequest = new WebRequest();
        webRequest.method = 'PUT';
        webRequest.uri = `${managementEndpointUrl}/subscriptions/${subscriptionId}/providers/Microsoft.Security/assessmentMetadata/${metadata_guid}?api-version=2020-01-01`;
        webRequest.headers = {
            'Authorization': 'Bearer ' + azureSessionToken,
            'Content-Type': 'application/json; charset=utf-8'
        }

        webRequest.body = JSON.stringify({
            "properties": {
                "displayName": getAssessmentName(details),
                "description": details.description,
                "remediationDescription": details.remediationSteps,
                "category": [
                    "Compute"
                ],
                "severity": severity,
                "userImpact": "Low",
                "implementationEffort": "Low",
                "assessmentType": "CustomerManaged"
            }
        });

        sendRequest(webRequest).then((response: WebResponse) => {
            // console.log("Response", JSON.stringify(response));
            let accessProfile = response.body;
            if (accessProfile && accessProfile.name) {
                // console.log("Successfully created assessment metadata", JSON.stringify(response.body));
                resolve(accessProfile.name);
            } else {
                reject(JSON.stringify(response.body));
            }
        }).catch(reject);
    });
}

function createAssessment(azureSessionToken: string, subscriptionId: string, managementEndpointUrl: string, metadata_guid: string, details: Details): Promise<string> {
    let resourceGroupName = core.getInput('resource-group', { required: true });
    let clusterName = core.getInput('cluster-name', { required: false });
    let webAppName = core.getInput('web-app-name', { required: false });
    
    let scope = "";
    if (!clusterName && !webAppName) {
        throw new Error("Supply clusterName or webAppName");
    }

    if (clusterName) {
        scope = `subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
    }
    if (webAppName) {
        scope = `subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}//providers/Microsoft.Web/sites/${webAppName}`
    }


    return new Promise<string>((resolve, reject) => {

        var webRequest = new WebRequest();
        webRequest.method = 'PUT';
        webRequest.uri = `${managementEndpointUrl}/${scope}/providers/Microsoft.Security/assessments/${metadata_guid}?api-version=2020-01-01`;
        webRequest.headers = {
            'Authorization': 'Bearer ' + azureSessionToken,
            'Content-Type': 'application/json; charset=utf-8'
        }

        webRequest.body = JSON.stringify({
            "properties": {
                "resourceDetails": {
                    "id": `${managementEndpointUrl}/${scope}`,
                    "source": "Azure"
                },
                "status": {
                    "cause": "Created Using a GitHub action",
                    "code": conclusion,
                    "description": details.description
                }
            }
        });

        sendRequest(webRequest).then((response: WebResponse) => {
            // console.log("Response", JSON.stringify(response));
            if (response.statusCode == 200) {
                console.log("Successfully created Assessment")
                resolve();
            } else {
                console.log('Assessment creation failed')
                reject(JSON.stringify(response.body));
            }
        }).catch(reject);
    });
}

async function createASCAssessment(): Promise<void> {
    let creds = core.getInput('creds', { required: true });
    let credsObject: { [key: string]: string; };
    try {
        credsObject = JSON.parse(creds);
    } catch (ex) {
        throw new Error('Credentials object is not a valid JSON');
    }

    let servicePrincipalId = credsObject["clientId"];
    let servicePrincipalKey = credsObject["clientSecret"];
    let tenantId = credsObject["tenantId"];
    let authorityUrl = credsObject["activeDirectoryEndpointUrl"] || "https://login.microsoftonline.com";
    let managementEndpointUrl = credsObject["resourceManagerEndpointUrl"] || "https://management.azure.com/";
    let subscriptionId = credsObject["subscriptionId"];
    let azureSessionToken = await getAzureAccessToken(servicePrincipalId, servicePrincipalKey, tenantId, authorityUrl);

    let metadata_guid = uuidv4();

    const details: Details = await getDetails();

    await createAssessmentMetadata(azureSessionToken, subscriptionId, managementEndpointUrl, metadata_guid, details);
    await createAssessment(azureSessionToken, subscriptionId, managementEndpointUrl, metadata_guid, details);
}

async function run() {
    console.log("Creating ASC assessment")
    await createASCAssessment();
}

console.log("Run")
run().catch(core.setFailed);