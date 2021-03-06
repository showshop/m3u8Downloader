const URL = require("url");
const md5 = require("md5");
const { exec } = require("child_process");
const path = require("path");
const utils = require("./utils");
const WorkerPool = require("../thread/workerPool.js");
const os = require("os");
const fs = require("fs");
const axios = require("axios").default;
const ProgressBar = require("progress");

let maxPN = os.cpus().length * 4;
let tsCount = 0;
let tsList = [];
let tsOutPuts = [];
let downloadedNum = 0;
let url = "";
let dir = "";
let fileName = "result";
// 线程池
let pool = null;
let mp4Num = 0;
let mp4DoneNum = 0;
let toConcat = [];
let bar;

let config = null;

function download(opts) {
  pool = new WorkerPool(opts.processNum || maxPN);
  url = opts.url;
  if (!opts.fileName) {
    opts.fileName = md5(url);
  }

  config = opts;

  fileName = opts.fileName;
  dir = path.join(opts.filePath, fileName);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }

  axios
    .get(url)
    .then((res) => {
      parseM3U8(res.data);
    })
    .catch(function (error) {
      console.log(error);
    })
    .finally(function () {});
}

function parseM3U8(content) {
  utils.log("开始解析m3u8文件...");
  tsList = content.match(/((http|https):\/\/.*)|(.+\.ts)/g);
  if (!tsList) {
    utils.logError("m3u8 file error");
    utils.log(content);
    return;
  }
  tsCount = tsList.length;
  tsOutPuts = [];
  const urlObj = URL.parse(url);
  const host = `${urlObj.protocol}//${urlObj.host}`;
  const urlPath = url.substr(0, url.lastIndexOf("/") + 1);

  for (let i = 0; i < tsCount; i++) {
    if (tsList[i].indexOf("http") < 0) {
      if (tsList[i].indexOf("/") === 0) {
        tsList[i] = host + tsList[i];
      } else {
        tsList[i] = urlPath + tsList[i];
      }
    }
    const tsOut = `${dir}/${i}.ts`;
    tsList[i] = {
      index: i,
      url: tsList[i],
      file: tsOut,
    };
    tsOutPuts.push(tsOut);
  }
  utils.log("解析成功，开始下载...");
  batchDownload();
}
function batchDownload() {
  bar = new ProgressBar(
    "  Downloading::percent [:bar]  Current::current Total::total 当前用时::elapseds 剩余时长::etas",
    { total: tsCount, width: 100 }
  );
  for (let i = 0; i < tsCount; i++) {
    pool.runTask(tsList[i], (result) => {
      if (!result.error) {
        downloadedNum++;
        bar.tick();
        checkIfDone();
      } else if (result.task) {
        utils.logError(
          `${result.error}, file name: ${result.task.file}, url: ${res.task.url}, redownloading...`
        );
        pool.runTask(result.task, arguments.callee);
      } else {
        utils.logError(result.error);
      }
    });
  }
}

function checkIfDone() {
  if (downloadedNum === tsCount) {
    pool.close();
    convertTS();
  }
}

function convertTS() {
  toConcat = utils.arrayChunk(tsOutPuts, 100);
  utils.log("正在合并ts为mp4...");
  mp4Num = toConcat.length;
  doConvert(0);
}

function doConvert(index) {
  if (mp4Num === mp4DoneNum) {
    concatMP4();
  } else {
    const outPutMP4 = `${dir}/output${index}.mp4`;
    const strConcat = toConcat[index].join("|");
    if (strConcat !== "") {
      if (fs.existsSync(outPutMP4)) {
        fs.unlinkSync(outPutMP4);
      }
      const cmd = `ffmpeg -i "concat:${strConcat}" -acodec copy -vcodec copy -absf aac_adtstoasc ${outPutMP4}`;
      exec(cmd, (error) => {
        if (error) {
          utils.logError(`ffmpeg mp4 ${index} error: ${error.message}`);
          doConvert(index);
        }
        utils.log(`${index + 1}. FFMPEG mp4 ${index}处理完成.`);
        mp4DoneNum++;
        doConvert(index + 1);
      });
    }
  }
}

function concatMP4() {
  const lastMP4 = `${dir}/${fileName}.mp4`;
  if (fs.existsSync(lastMP4)) {
    utils.log("最终文件已存在,跳过生成,至此所有FFMPEG处理完成.");
    deleteTS();
    return;
  }

  if (mp4Num > 1) {
    let filelist = "";
    for (let i = 0; i < mp4Num; i++) {
      filelist += `file ${config.filePath}/${config.fileName}/output${i}.mp4 \n`;
    }
    const filePath = path.join(dir, "filelist.txt");
    fs.writeFileSync(filePath, filelist);
    const cmd = `ffmpeg -f concat -i ${filePath} -c copy ${lastMP4}`;
    exec(cmd, (error) => {
      if (error) {
        utils.logError(`ffmpeg mp4ALL error: ${error.message}`);
        utils.exit();
      }
      utils.log("所有FFMPEG处理完成.");
      deleteTS();
    });
  } else {
    fs.rename(path.join(dir, "output0.mp4"), lastMP4, (err) => {
      if (err) {
        utils.logError(`rename last mp4 error: ${err.message}`);
        utils.exit();
      }
      deleteTS();
    });
  }
}

const glob = require("glob");

/**
 * 文件清理工作
 */
function deleteTS() {
  if (!config.deleteTemp) {
    return;
  }

  const execCB = (err) => {
    if (err) throw err;
  };

  const deletePath = [
    `${config.filePath}/${config.fileName}/*.ts`,
    `${config.filePath}/${config.fileName}/output*.mp4`,
    `${config.filePath}/${config.fileName}/filelist.txt`,
  ];

  deletePath.forEach((filePath) => {
    glob(filePath, {}, function (er, files) {
      files.forEach((item) => {
        fs.unlink(item, execCB);
      });
    });
  });
}

module.exports = {
  download: download,
};
