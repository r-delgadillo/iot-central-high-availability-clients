'use strict';
const { exec } = require('child_process');
// Azure IoT Device SDK
const Protocol = require('azure-iot-device-mqtt').Mqtt;
const Client = require('azure-iot-device').Client;
const Message = require('azure-iot-device').Message;
const ExponentialBackOffWithJitter = require('azure-iot-common').ExponentialBackOffWithJitter;

// Azure IoT DPS SDK
const ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
const SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
const ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;

// Crypto SDK needed for computing device keys
const crypto = require('crypto');

// device settings - FILL IN YOUR VALUES HERE
// const scopeId = '<Put your scope id here from IoT Central Administration -> Device connection>';
// const groupSymmetricKey = '<Put your group SAS primary key here from IoT Central Administration -> Device Connection -> SAS-IoT-Devices>';
const scopeId = process.argv[3];
const deviceKey = process.argv[5];
const groupSymmetricKey = process.argv[6];

// optional device settings - CHANGE IF DESIRED/NECESSARY
// const provisioningHost = 'global.azure-devices-provisioning.net';
const provisioningHost = process.argv[4] || 'global.azure-devices-provisioning.net';
const deviceId = process.argv[2] || 'failover_js';
const modelId = 'dtmi:Sample:Failover;1';  // This model is available in the root of the Github repo (Failover.json) and can be imported into your Azure IoT central application

// test setting flags
const telemetrySendOn = true
const reportedPropertySendOn = true
const desiredPropertyReceiveOn = true
const directMethodReceiveOn = true
const c2dCommandReceiveOn = true

// general purpose variables
let client = null;
let deviceTwin = null;
let connected = false;


// calculate the device key using the symetric group key
function computeDerivedSymmetricKey(masterKey, deviceId) {
    return crypto.createHmac('SHA256', Buffer.from(masterKey, 'base64'))
        .update(deviceId, 'utf8')
        .digest('base64');
}


// Azure IoT Central custom retry policy derived from ExponentialBackOffWithJitter
class MultiHubRetryPolicy extends ExponentialBackOffWithJitter {
    constructor(...args) {
        super(...args);
    }

    shouldRetry(err) {
        if (err.message === 'Connection refused: Server unavailable') {
            return false; // if hub not available stop retry and fall back to DPS
        }

        return super.shouldRetry(err);
    }

    nextRetryTimeout(retryCount, throttled) {
        return super.nextRetryTimeout(retryCount, throttled);
    }
}


// handler for C2D message
async function messageHandler(msg) {
    const methodName = msg.properties.propertyList.find(o => o.key === 'method-name');

    if (methodName) {
        switch (methodName.value) {
            case 'setAlarm':
                console.log(`C2D method: ${methodName.value}(${msg.data.toString('utf-8')})`);

                await setAlarmCommandHandler(msg);
                break;

            default:
                console.log(`Unknown C2D method received: ${methodName.value}`);
        }
    }
}


// connect to IoT Central/Hub via Device Provisioning Servicee (DPS)
async function connect() {
    try {
        // calc device symmetric key from group symmetric key
        const deviceSymmetricKey = deviceKey || computeDerivedSymmetricKey(groupSymmetricKey, deviceId);

        // DPS provision with device symmetric key
        const provisioningSecurityClient = new SymmetricKeySecurityClient(deviceId, deviceSymmetricKey);
        const provisioningClient = ProvisioningDeviceClient.create(provisioningHost, scopeId, new ProvisioningTransport(), provisioningSecurityClient);

        // set the model to register against
        provisioningClient.setProvisioningPayload({
            iotcModelId: modelId
        });

        // register the device and get the hub host name
        const connectionString = await new Promise((resolve, reject) => {
            provisioningClient.register((dpsError, dpsResult) => {
                if (dpsError) {
                    console.log(`DPS register failed: ${JSON.stringify(dpsError, null, 4)}`);

                    return reject(dpsError);
                }

                console.log('registration succeeded');
                console.log(`assigned hub: ${dpsResult.assignedHub}`);
                console.log(`deviceId: ${dpsResult.deviceId}`);

                return resolve(`HostName=${dpsResult.assignedHub};DeviceId=${dpsResult.deviceId};SharedAccessKey=${deviceSymmetricKey}`);
            });
        });

        // create client from connection string
        client = Client.fromConnectionString(connectionString, Protocol);

        // cannot use the default retry logic built into the SDK as it will not fallback to DPS
        client.setRetryPolicy(new MultiHubRetryPolicy());

        // monitor for connects, disconnects, errors, and c2d messages
        client.on('connect', connectHandler);
        client.on('disconnect', disconnectHandler);
        client.on('error', errorHandler);

        if (c2dCommandReceiveOn) {
            client.on('message', messageHandler);
        }

        // connect to IoT Hub
        await client.open();

        // obtain twin object
        deviceTwin = await client.getTwin();

        if (desiredPropertyReceiveOn) {
            deviceTwin.on('properties.desired', desiredPropertyHandler);
        }

        // handlers for the direct method
        if (directMethodReceiveOn) {
            client.onDeviceMethod('echo', echoCommandDirectMethodHandler);
        }
    }
    catch (err) {
        console.error(`Could not connect: ${err.message}`);
        throw new Error(`Hub connect error! Error: ${err.message}`);
    }
}


// handlef for connection event
function connectHandler() {
    console.log('Connected to IoT Central');
    connected = true;
}


// handler for disconnects, reconnect via DPS
async function disconnectHandler() {
    if (connected) {
        connected = false;
        console.log('Disconnected from IoT Central');

        await client.close()

        await connect();
    }
}


// handler for errors
function errorHandler(err) {
    console.log(`Error caught in error handler: ${err}`);
}


// sends telemetry on a set frequency
async function sendTelemetry() {
    if (connected) {
        const telemetry = {
            temp: (20 + (Math.random() * 100)).toFixed(2),
            humidity: (Math.random() * 100).toFixed(2)
        };

        const message = new Message(JSON.stringify(telemetry));

       await  new Promise(async (resolve,reject) => {
            await client.sendEvent(message, (err) => {
                if (err) {
                    return reject(err);
                }
                else {
                    console.log(`Completed telemetry send ${JSON.stringify(telemetry)}`);
                    return resolve();
                }
            });
        });
    }
}

async function updateDeviceProperties(properties) {
    if (!deviceTwin) {
        return;
    }
    await new Promise((resolve, reject) => {
        deviceTwin.properties.reported.update(properties, (err) => {
            if (err) {
                return reject(err);
            }
            else {
                console.log(`Completed property send ${JSON.stringify(properties)}`);
                return resolve();
            }
        });
    });
}


// sends reported properties on a set frequency
async function sendReportedProperty() {
    if (connected) {
        const reportedPropertyPatch = {
            battery: (Math.random() * 100).toFixed(2)
        };

        await updateDeviceProperties(reportedPropertyPatch);
    }
}


// handles desired properties from IoT Central (or hub)
async function desiredPropertyHandler(patch) {
    if (Object.keys(patch).length > 1) {
        console.log(`Desired property received, the data in the desired properties patch is: ${JSON.stringify(patch)}`);

        // acknowledge the desired property back to IoT Central
        let key = Object.keys(patch)[0];
        if (key === '$version') {
            key = Object.keys(patch)[1];
        }

        const reported_payload = {};
        reported_payload[key] = {
            value: patch[key],
            ac: 200,
            ad: 'completed',
            av: patch['$version']
        };

        await updateDeviceProperties(reported_payload);
    }
}


// handles direct method 'echo' from IoT Central (or hub)
async function echoCommandDirectMethodHandler(request, response) {
    console.log(`Executing direct method request: ${request.methodName} "${request.payload}"`);

    try {
        // echos back the request payload
        await response.send(200, request.payload);
    }
    catch (err) {
        console.log(`Error in command response: ${err.message}`);
    }
}


// handles the Cloud to Device (C2D) message setAlarm
async function setAlarmCommandHandler(msg) {
    try {
        // delete the message from the device queue
        await client.complete(msg);
    }
    catch (err) {
        console.log(`Error handling C2D method: ${err.message}`);
    }
}


async function main() {
    try {
        clearDns();
        await startDevice();        
    } catch(e) {
        console.log('Device connection error, attempt to reconnect in 5 seconds')
        await sleep(5000);
        await main();
    }
}
main();

async function sleep(ms) {
    return new Promise((resolve, reject) => setTimeout(() =>resolve(), ms));
}

function clearDns() {
    console.log('------Clear DNS');

    exec("sudo systemd-resolve --flush-caches", (err,stdout, stderr) => { });
    
    console.log('------Clear DNS');
}

async function startDevice() {
    try {
        console.log('Press Ctrl-C to exit from this when running in the console');
        console.log('DeviceId: ' + deviceId);
        console.log('Scope: ' + scopeId);
        console.log('Group Key: ' + groupSymmetricKey);
        console.log('Device Key: ' + deviceKey);
        console.log('Provisioning Host: ' + provisioningHost);

        // connect to IoT Central/Hub via Device Provisioning Service (DPS)
        await connect();

        while(true) {
            if (telemetrySendOn) {
                await sendTelemetry()
            }
            
            if (reportedPropertySendOn) {
                await sendReportedProperty();  // send reported property every 15 seconds
            }
            await sleep(10000)
        }

    } catch (e) {
        try {
            console.log('Start Device Error:');
            console.log(e);
            if (cient) {
                await client.close();
            }
            client = undefined;
        } catch (err) {
            
        }
        finally{
            await main()
        }
    }
}