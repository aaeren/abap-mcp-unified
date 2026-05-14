const { ADTClient, session_types } = require('abap-adt-api');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function fetchSource(objectName) {
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
    // Filter by exact name and common program/class types
    const obj = results.find(r => r['adtcore:name'].toUpperCase() === objectName.toUpperCase());
    
    if (!obj) {
        throw new Error(`Object ${objectName} not found`);
    }
    
    const sourceUrl = obj['adtcore:uri'] + '/source/main';
    const source = await client.getObjectSource(sourceUrl);
    return source;
}

const name = process.argv[2];

if (!name) {
    console.error('Usage: node fetch_abap_source.js <OBJECT_NAME>');
    process.exit(1);
}

fetchSource(name)
    .then(source => {
        process.stdout.write(source);
        process.exit(0);
    })
    .catch(err => {
        console.error(err.message);
        process.exit(1);
    });
