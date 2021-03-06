const fs = require('fs');
const AParser = require('a-parser-client');
const Iconv = require('iconv').Iconv;
const iconv = new Iconv('CP1251', 'UTF-8');
const axios = require('axios');
const punycode = require('punycode/');
let aparser;

const defaultConfig = {
    'link': 'http://127.0.0.1:9091/API',
    'password': '',
    'task_folder': './tasks',
    'result_folder': './results',
    'exclusions_file': './exclusions.txt',
    'delay': 60,
};

const parsers = {
    'Bing': 'Order::2568_Bing',
    'Google': 'Order::2568_Google',
    'Yandex': 'Order::2568_Yandex',
    'Google Maps': 'Order::2568_GoogleMaps',
    'Yandex Maps': 'Order::2568_YandexMaps',
};

// Load and check settings 
let config;
let exclusions;
if (fs.existsSync('./config.txt')) {
    console.log('Found config.txt');
    console.log('Getting settings...');
    const file = fs.readFileSync('./config.txt', 'utf8');
    const lines = file.split('\n');
    config = lines.reduce((acc, item) => {
        const [key, value] = item.replace(/\r/g, '').split(/:\s?/);
        acc[key] = value;
        return acc;
    }, {});

    console.log('Checking settings...');
    for (let key of Object.keys(defaultConfig)) {
        if (!(key in config)) {
            console.warn(`Parameter ${key} not exists`);
            console.log(`Set default value ${defaultConfig[key]}`);
            config[key] = defaultConfig[key];
        }
    }
}

else {
    console.warn('File config.txt not found');
    console.log('Creating default config.txt...');
    const file = Object.keys(defaultConfig).map(key => {
        const value = defaultConfig[key];
        return `${key}: ${value}`;
    }).join('\n');

    fs.writeFileSync('./config.txt', file);
    console.log('File config.txt created');

    config = Object.assign({}, defaultConfig);
}

if (!config) {
    console.error('Something went wrong, config.txt not loaded');
    return;
}

console.log('Load exclusions file...');
if (fs.existsSync(config['exclusions_file'])) {
    const rawExclusionsFile = fs.readFileSync(config['exclusions_file'], 'utf-8');
    exclusions = rawExclusionsFile.split(/[\r\n]+/g);
    uniqueExclusions = [...new Set(exclusions)];
    uniquePercent = parseInt((uniqueExclusions.length / exclusions.length) * 100);
    console.log(`Found ${exclusions.length} exclusions (${uniquePercent}% unique)`);
    exclusions = exclusions.join('|');
    exclusions = exclusions.replace(/\./g, '\\.');
    exclusions = new RegExp(exclusions, 'i');
    console.log('Exclusions preview:', exclusions);
}

else {
    exclusions = [];
    console.log(`Exclusions file ${config['exclusions_file']} not found`);
}

console.log('Settings loaded');
console.info('config.txt preview:', JSON.stringify(config));
for (let dir of [config.task_folder, config.result_folder]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
}

// Connect to API
(async () => {
    aparser = new AParser(config.link, config.password);

    // Check connection
    let connected = false;
    await new Promise(async (resolve, reject) => {
        let res;
        try {
            res = await aparser.ping();
        }

        catch(error) {
            reject(`Can't connect to A-Parser: ${error}`);
        }

        if (res.data === 'pong') resolve();
        else reject(`Something went wrong with A-Parser: ${JSON.stringify(res)}`);
    }).then(() => {
        console.log('A-Parser connected');
        connected = true;
    }).catch(error => {
        console.log(error);
    });

    if (!connected) return;
    console.log(`Checking delay is ${config.delay} sec`);
    checkDir();
})();

function generateCode(length = 8) {
    const symbols = [...'0123456789qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM'];
    let code = '';
    
    for (let i = 0; i < length; i++) {
        code += symbols[Math.floor(Math.random() * symbols.length)];
    }

    return code;
}

async function checkDir() {
    console.log(`Checking ${config.task_folder}...`);
    const filenames = fs.readdirSync(config.task_folder);

    if (filenames) {
        console.log(`Found ${filenames.length} tasks`);
        for (let filename of filenames) {
            const name = filename.replace(/\.\w+$/, '');
            const raw = fs.readFileSync(`${config.task_folder}/${filename}`);
            const file = iconv.convert(raw).toString();

            fs.unlinkSync(`${config.task_folder}/${filename}`);
            console.log(`File ${filename} readed and removed`);
            const uniqueBaseName = generateCode();
            const queries = file.split(/[\r\n]+/).filter(item => item);

            // Debug info
            console.log({ filename, name, file, exclusions, queries, uniqueBaseName });
            const resultName = `cites web done][${name}.csv`;

            let promises = [];
            for (let key of Object.keys(parsers)) {
                const promise = new Promise(async (resolve) => {
                    const preset = parsers[key];

                    let res = await aparser.makeRequest('addTask', {
                        queriesFrom: 'text',
                        queries,
                        configPreset: 'default',
                        resultsFileName: `${uniqueBaseName}.csv`,
                        preset,
                        keepUnique: uniqueBaseName,
                    });

                    const id = res.data;
                    console.log(res);

                    // Wait for task
                    let status;
                    await new Promise(async resolve => {
                        while (status != 'completed' && status != 'stopped' && status != 'paused') {
                            if (status != undefined) await sleep(5000);
                            res = await aparser.makeRequest('getTaskState', {
                                taskUid: id,
                            });

                            status = res.data.status;
                            console.log({ id, status });
                        }

                        resolve();
                    });

                    // Getting results file
                    console.log('done', { id, status });
                    res = await aparser.makeRequest('getTaskResultsFile', {
                        taskUid: id,
                    });

                    const link = res.data;
                    console.log('results file', link);
                    resolve(link);

                    // console.log(resultsFile);
                    // console.log(typeof resultsFile.data);
                });

                promises.push(promise);
            }

            const link = (await Promise.all(promises))?.pop();
            const resultsFile = await axios.get(link);
            const allLinks = resultsFile.data.split(/\n/);
            const filteredLinks = allLinks.filter(item => !exclusions.test(item));
            const excluded = allLinks.filter(item => !filteredLinks.includes(item));
            console.log({ excluded });
            const resultFileText = filteredLinks.map(item => {
                if (/\.xn--p1ai;/.test(item)) {
                    const url = /(^.+?\.xn--p1ai)/.exec(item)?.pop();
                    console.log({ url, item });
                    const decoded = punycode.toUnicode(url);
                    item = item.replace(url, decoded);
                    console.log(url, decoded);
                }

                return item;
            }).join('\n');

            fs.writeFileSync(`${config.result_folder}/${resultName}`, resultFileText);
        }
    }

    else {
        console.log(`Tasks not found`);
    }

    setTimeout(() => {
        checkDir();
    }, config.delay * 1000);
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(() => resolve(), ms);
    });
}