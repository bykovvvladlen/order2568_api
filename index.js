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

async function checkDir() {
    console.log(`Checking ${config.task_folder}...`);
    const filenames = fs.readdirSync(config.task_folder);

    if (filenames) {
        console.log(`Found ${filenames.length} tasks`);
        for (let filename of filenames) {
            const [prefix, name] = filename.replace(/\.\w+$/, '').split('][');
            const raw = fs.readFileSync(`${config.task_folder}/${filename}`);
            const file = iconv.convert(raw).toString();

            fs.unlinkSync(`${config.task_folder}/${filename}`);
            console.log(`File ${filename} readed and removed`);

            const task = file
                .split(/\r\n/)
                .filter(item => item)
                .map(item => {
                    return item
                        .replace(/"{3}/g, '"')
                        .split(/;/);
                });

            const [i, v] = task.reduce((acc, item, index) => {
                if (index > 0) {
                    if (item[0]) {
                        acc[0].push(item[0]);
                    }

                    if (item[1]) {
                        acc[1].push(item[1])
                    }
                }

                return acc;
            }, [[], []]);

            const queries = i
                .map(item => {
                    return v.map(sub => `${item} ${sub}`);
                })
                .flat()
                .concat(v
                    .map(item => {
                        return i.map(sub => `${item} ${sub}`);
                    })
                    .flat());

            // Debug info
            console.log({ filename, prefix, name, file, task, i, v, queries });

            for (let key of Object.keys(parsers)) {
                new Promise(async () => {
                    const preset = parsers[key];
                    const resultName = `cites web done][${name}][${key}.csv`;

                    let res = await aparser.makeRequest('addTask', {
                        queriesFrom: 'text',
                        queries,
                        configPreset: 'default',
                        resultsFileName: '$datefile.format().txt',
                        preset,
                    });

                    const id = res.data;
                    console.log(res);

                    // Wait for task
                    await new Promise(async resolve => {
                        let status;
                        while (status != 'completed') {
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
                    console.log({ id, done: true });
                    res = await aparser.makeRequest('getTaskResultsFile', {
                        taskUid: id,
                    });

                    const link = res.data;
                    console.log('results file', link);

                    const resultsFile = await axios.get(link);
                    // console.log(resultsFile);
                    // console.log(typeof resultsFile.data);

                    const resultFileText = resultsFile.data.split(/\n/).map(item => {
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
                });
            }
        }
    }

    else {
        console.log(`Tasks not found`);
    }

    setTimeout(() => {
        checkDir();
    }, config.delay * 1000);
}

const sleep = (ms) => {
    return new Promise(resolve => {
        setTimeout(() => resolve(), ms);
    });
}