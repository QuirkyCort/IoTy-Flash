import { ESPLoader, Transport } from './bundle.js';
// import { ESPLoader, Transport } from 'https://unpkg.com/esptool-js@0.3.0/bundle.js';

const directories = ['ioty', 'umqtt', 'ioty/html'];
// const firmwarePath = 'https://ioty-flash.a9i.sg/firmware/';
const files = [
  'boot.py',
  'ioty/ble.mpy',
  'ioty/http.mpy',
  'ioty/monitor.mpy',
  'ioty/monitor_mqtt.mpy',
  'ioty/mqtt.mpy',
  'ioty/pin.mpy',
  'ioty/services.mpy',
  'ioty/html/index.html',
  'umqtt/robust.mpy',
  'umqtt/simple.mpy',
  'ioty/wifi.mpy'
];
const fileConstants = 'ioty/constants.py';
const chunkSize = 256;
const chunkDelay = 10;

const FIRMWARE = {
  'firmware-ESP32-C3-1.24.1': {
    url: 'ESP32_GENERIC_C3-20241129-v1.24.1.bin',
    address: 0x0,
    bootPin: 9,
    ledPin: 8
  },
  'firmware-1.19.1': {
    url: 'firmware-1.19.1.espnow.bin',
    address: 0x1000
  },
  'firmware-1.23.0': {
    url: 'ESP32_GENERIC-20240602-v1.23.0.bin',
    address: 0x1000
  },
  'firmware-1.22.2_camera': {
    url: 'micropython_v1.22.2_camera_no_ble.bin',
    address: 0x1000
  }
};

let usbFilters = [
  { // CH9102F (non-standard?)
    usbVendorId: 0x1a86,
    usbProductId: 0x55d4
  },
  { // CP2102
    usbVendorId: 0x10c4,
    usbProductId: 0xea60
  },
  { // CH340
    usbVendorId: 0x1a86,
    usbProductId: 0x7523
  },
  { // ESP32-C3 Supermini
    usbProductId: 4097,
    usbVendorId: 12346
  },
];

function bufferToString(buffer) {
  const bytes = new Uint8Array(buffer);
  return bytes.reduce((string, byte) => (string + String.fromCharCode(byte)), '');
}

function concatArray(a, b) {
  let newArray = new Uint8Array(a.length + b.length);
  newArray.set(a, 0);
  newArray.set(b, a.length);

  return newArray;
}

async function awaitTimeout(delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

function findSubarray(arr, subarr, from_index=0) {
  var i, found, j;
  for (i = from_index; i < 1 + (arr.length - subarr.length); ++i) {
      found = true;
      for (j = 0; j < subarr.length; ++j) {
          if (arr[i + j] !== subarr[j]) {
              found = false;
              break;
          }
      }
      if (found) return i;
  }
  return -1;
};

function toPythonBytesLiteral(bytes) {
  let s = '';

  for (let b of bytes) {
    let c;

    if (b >= 32 && b <= 126) {
      c = String.fromCharCode(b);
      if (b == 39 || b == 92) {
        c = '\\' + c;
      }
    } else if (b < 16) {
      c = '\\x0' + b.toString(16);
    } else {
      c = '\\x' + b.toString(16);
    }

    s += c;
  }

  return s;
}

var terminal = new function() {
  let self = this;

  this.init = function(name) {
    self.ele = document.getElementById(name);
  }

  this.clean = function() {
    self.ele.innerText = '';
  }

  this.writeLine = function(data) {
    self.write(data + '\n');
  }

  this.write = function(data) {
    self.ele.innerText += data;
    self.ele.scrollTop = self.ele.scrollHeight - self.ele.clientHeight
  }
};

var main = new function() {
  let self = this;

  this.address = 0x1000;

  // Run on page load
  this.init = function() {
    self.baudrateSelect = document.getElementById('baudrate');
    self.connectBtn = document.getElementById('connect');
    self.filteredConnectBtn = document.getElementById('filteredConnect');
    self.flashMicropythonBtn = document.getElementById('flashMicropython');
    self.loadedMicropythonSpan = document.getElementById('loadedMicropython');
    self.flashIoTyBtn = document.getElementById('flashIoTy');
    self.deviceNameInput = document.getElementById('deviceName');
    self.dtrRts = document.getElementById('dtrRts');
    self.formatLittleFS = document.getElementById('formatLittleFS');
    self.noWebSerial = document.getElementById('noWebSerial');

    self.connectBtn.addEventListener('click', self.connect);
    self.filteredConnectBtn.addEventListener('click', self.filteredConnect);
    self.flashMicropythonBtn.addEventListener('click', self.flashMicropython);
    self.flashIoTyBtn.addEventListener('click', self.flashIoTy);

    if ('serial' in navigator) {
      terminal.writeLine('No firmware loaded. Be sure to load a firmware before flashing.');
    } else {
      terminal.writeLine('Web Serial not supported on this browser!');
      self.noWebSerial.classList.remove('hide');
    }

    for (let e of document.getElementsByClassName('firmware')) {
      e.addEventListener('click', self.downloadFirmware);
    };

    self.downloadIotyFirmware();
  }

  this.downloadIotyFirmware = async function() {
    self.firmwareMPY = {};
    self.constantsPy = null;
    for (let file of files) {
      let response = await fetch('firmware/' + file);
      let bytes = await response.arrayBuffer();
      self.firmwareMPY[file] = { content: new Uint8Array(bytes) };
    }
    let response = await fetch('firmware/' + fileConstants);
    let bytes = await response.arrayBuffer();
    self.constantsPy = new Uint8Array(bytes);
  }

  this.downloadFirmware = async function(e) {
    self.firmware = FIRMWARE[e.target.id];

    terminal.write('Preloading firmware. Wait for completion before continuing... ');
    let response = await fetch(self.firmware.url);
    let bytes = await response.arrayBuffer();
    self.firmwareData = bufferToString(bytes);

    terminal.writeLine('Done');
    terminal.writeLine('You can flash your ESP32 now.');

    self.loadedMicropythonSpan.innerText = 'Loaded ' + self.firmware.url;
  }

  this.connect = async function(filters=[]) {
    if (! ('serial' in navigator)) {
      terminal.writeLine('Web Serial not supported on this browser!');
      return;
    }

    try {
      if (filters.length > 0) {
        self.port = await navigator.serial.requestPort({filters: filters});
      } else {
        self.port = await navigator.serial.requestPort();
      }
      terminal.writeLine('Serial port connected. You can now proceed to step 2.');
    } catch (error) {
      terminal.writeLine(error);
    }
  }

  this.filteredConnect = async function() {
    await self.connect(usbFilters);
  }

  this.flashMicropython = async function() {
    try {
      let transport = new Transport(self.port);
      let flashOptions = {
        transport,
        baudrate: parseInt(self.baudrateSelect.value),
        terminal: terminal,
      };
      self.esploader = new ESPLoader(flashOptions);

      terminal.writeLine('If the "Connecting..." message takes more than a couple of seconds, press and hold the boot button on your ESP32 until the chip is detected.');

      await self.esploader.main_fn();

      await awaitTimeout(1000);

      await self.esploader.erase_flash();

      let fileArray = [{
        data: self.firmwareData,
        address: self.firmware.address
      }];

      flashOptions = {
        fileArray: fileArray,
        flashSize: "keep",
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {},
        calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
      };
      await self.esploader.write_flash(flashOptions);
      terminal.writeLine('Done. You can now proceed to step 3.');
    } catch (error) {
      terminal.writeLine(error);
      terminal.writeLine('If you are connected to the device on another tab or program, be sure to disconnect first.');
    }

    self.port.close();
  }

  this.modifyConstants = function() {
    let textdecoder = new TextDecoder();
    let textencoder = new TextEncoder();
    let constantsPyStr = textdecoder.decode(self.constantsPy);
    if ('bootPin' in self.firmware) {
      terminal.writeLine('    Modifying _BOOT_PIN to ' + self.firmware.bootPin);
      constantsPyStr = constantsPyStr.replace('_BOOT_PIN = 0', '_BOOT_PIN = ' + self.firmware.bootPin);
    }
    if ('ledPin' in self.firmware) {
      terminal.writeLine('    Modifying _LED_PIN to ' + self.firmware.ledPin);
      constantsPyStr = constantsPyStr.replace('_LED_PIN = 2', '_LED_PIN = ' + self.firmware.ledPin);
    }
    self.firmwareMPY['ioty/constants.py'] = { content: textencoder.encode(constantsPyStr) };
  }

  this.flashIoTy = async function() {
    let deviceName = self.deviceNameInput.value;
    let dtrRts = self.dtrRts.value;
    let formatLittleFS = self.formatLittleFS.checked;

    deviceName = deviceName.trim();
    if (deviceName == '') {
      terminal.writeLine('Device name cannot be empty');
      return;
    }
    if (deviceName.length > 8) {
      terminal.writeLine('Device name cannot exceed 8 characters');
      return;
    }

    terminal.writeLine('Resetting');

    await self.reset();

    await awaitTimeout(1000);

    try {
      await self.openPort(dtrRts);
    } catch (error) {
      terminal.writeLine(error);
      return;
    }

    let r;
    terminal.write('Terminating running program... ');
    self.clearBuf();
    self.sendCtrlC();
    r = await self.waitForString('>>> ', 5000);
    if (r == null) {
      terminal.writeLine('Timeout waiting for Python prompt');
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    terminal.write('Switching to raw mode... ');
    self.sendCtrlA();
    r = await self.waitForString('>');
    if (r == null) {
      terminal.writeLine('Timeout waiting for raw mode prompt');
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    if (formatLittleFS) {
      terminal.write('Formating filesystem... ');
      if (await self.formatFilesystem() != 'success') {
        await self.closePort();
        return;
      }
      terminal.writeLine('Done');
    }

    terminal.write('Creating directories... ');
    if (await self.createDirectories(directories) != 'success') {
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    terminal.writeLine('Modify constants.py');
    self.modifyConstants();
    terminal.writeLine('Done');

    terminal.writeLine('Copying firmware files');
    for (let filename in self.firmwareMPY) {
      terminal.write('    copying ' + filename + '...')
      if (await self.copyFile(filename, self.firmwareMPY[filename].content) != 'success') {
        await self.closePort();
        return;
      };
      terminal.writeLine('Done');
    }

    terminal.writeLine('Setting device name');
    terminal.write('    writing "' + deviceName +'" to the _ioty_name file...')
    let e = new TextEncoder();
    let content = e.encode(deviceName);
    if (await self.copyFile('_ioty_name', content) != 'success') {
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    terminal.write('Exiting raw mode... ');
    self.sendCtrlB();
    r = await self.waitForString('>>> ');
    if (r == null) {
      terminal.writeLine('Timeout exiting raw mode');
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    await self.closePort();
    terminal.writeLine('Flash IoTy completed!');
  }

  this.reset = async function() {
    await self.openPort();
    await self.port.setSignals({dataTerminalReady: false, requestToSend: true});
    await self.port.setSignals({dataTerminalReady: false, requestToSend: false});
    await self.closePort();
  }

  this.openPort = async function(dtrRts=0) {
    await self.port.open({ baudRate: 115200 });

    console.log('dtrRts mode:', dtrRts)
    if (dtrRts == 1) {
      self.port.setSignals({
        dataTerminalReady: false,
        requestToSend: false
      });
    }

    self.reader = self.port.readable.getReader();
    self.writer = self.port.writable.getWriter();
    self.readBuf = new Uint8Array();
  }

  this.closePort = async function() {
    await self.reader.cancel();
    await self.writer.close();
    self.port.close();
  }

  this.clearBuf = function() {
    self.readBuf = new Uint8Array();
  }

  this.readSerial = async function() {
    const { value, done } = await self.reader.read();
    if (value) {
      self.readBuf = concatArray(self.readBuf, value);
    }
    if (done) {
      console.log('read done');
    }
    return value;
  }

  this.waitForString = async function(s, timeout=2000) {
    let e = new TextEncoder();
    let bytes = e.encode(s);

    let before = await self.waitForBytes(bytes, timeout);
    let d = new TextDecoder();
    if (before == null) {
      return before;
    }
    return d.decode(before);
  }

  this.waitForBytes = async function(b, timeout=2000) {
    while (true) {
      let result = await Promise.race([self.readSerial(), awaitTimeout(timeout)]);
      if (result == undefined) {
        return null;
      }

      let pos = findSubarray(self.readBuf, b);
      if (pos != -1) {
        let before = self.readBuf.slice(0, pos);
        self.readBuf = self.readBuf.slice(pos+b.length);
        return before;
      }
    }
  }

  // Stop current program
  this.sendCtrlC = function() {
    let cmd = new Uint8Array([0x0d, 0x03, 0x03]);
    self.writer.write(cmd);
  }

  // Enter raw REPL
  this.sendCtrlA = function() {
    let cmd = new Uint8Array([0x0d, 0x01]);
    self.writer.write(cmd);
  }

  // Exit raw REPL
  this.sendCtrlB = function() {
    let cmd = new Uint8Array([0x0d, 0x02]);
    self.writer.write(cmd);
  }

  // Soft reset OR Execute command (RAW mode)
  this.sendCtrlD = function() {
    let cmd = new Uint8Array([0x04]);
    self.writer.write(cmd);
  }

  this.sendPythonCmd = async function(string) {
    let e = new TextEncoder();
    let cmd = e.encode(string);
    while (cmd.length > 0) {
      let send = cmd.slice(0, chunkSize);
      cmd = cmd.slice(chunkSize);
      self.writer.write(send);
      await awaitTimeout(chunkDelay);
    }
  }

  this.sendPythonCmdAndRun = async function(string, terminator='CGLI5wxheI') {
    string += '\nprint("' + terminator + '")\n';
    await self.sendPythonCmd(string);
    self.sendCtrlD();
    if (await self.waitForString(terminator) == null) {
      terminal.writeLine('Timeout waiting for completion');
      return 'timeout';
    }
    return 'success';
  }

  this.formatFilesystem = async function() {
    return await self.sendPythonCmdAndRun(
      'import os\n' +
      'os.umount(\'/\')\n' +
      'os.VfsLfs2.mkfs(bdev)\n' +
      'os.mount(bdev, \'/\')\n'
    );
  }

  this.createDirectories = async function(directories) {
    let cmd = 'import os\n';

    for (let directory of directories) {
      cmd += 'os.mkdir("' + directory + '")\n';
    }

    return await self.sendPythonCmdAndRun(cmd);
  }

  this.copyFile = async function(filename, content) {
    let cmd = 'f = open("' + filename + '", "wb")\n';
    cmd += 'f.write(b\'' + toPythonBytesLiteral(content) + '\')\n';
    cmd += 'f.close()\n';

    return await self.sendPythonCmdAndRun(cmd);
  }
}

terminal.init('terminal');
main.init();