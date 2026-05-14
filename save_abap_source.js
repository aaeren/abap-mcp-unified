const { ADTClient, session_types } = require('abap-adt-api');
const fs = require('fs');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function saveSource(objectName, filePath, transport) {
    const client = new ADTClient(
        'https://tsys4hrdev.tosyali.local/',
        'xaeren',
        '30071996Ab',
        '100',
        'TR'
    );
    client.stateful = session_types.stateful;
    await client.login();
    
    // Find the object
    const results = await client.searchObject(objectName);
    const obj = results.find(r => r['adtcore:name'].toUpperCase() === objectName.toUpperCase());
    
    if (!obj) {
        throw new Error(`Object ${objectName} not found`);
    }
    
    const objectUrl = obj['adtcore:uri'];
    const sourceUrl = objectUrl + '/source/main';
    const source = fs.readFileSync(filePath, 'utf8');
    
    console.log(`Locking ${objectName}...`);
    const lock = await client.lock(objectUrl);
    try {
        console.log(`Saving ${objectName}...`);
        await client.setObjectSource(sourceUrl, source, lock.LOCK_HANDLE, transport);
    } finally {
        console.log(`Unlocking ${objectName}...`);
        await client.unLock(objectUrl, lock.LOCK_HANDLE);
    }
    
    console.log(`Activating ${objectName}...`);
    await client.activate(objectName, objectUrl);
    console.log('Success!');
}

const name = process.argv[2];
const path = process.argv[3];
const transport = process.argv[4];

if (!name || !path) {
    console.error('Usage: node save_abap_source.js <OBJECT_NAME> <FILE_PATH> [TRANSPORT]');
    process.exit(1);
}

saveSource(name, path, transport)
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err.message);
        process.exit(1);
    });
