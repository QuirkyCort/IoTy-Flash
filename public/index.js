import { ESPLoader, Transport } from 'https://unpkg.com/esptool-js@0.3.0/bundle.js';

const directories = ['ioty', 'umqtt', 'ioty/html'];
const firmwarePath = 'https://quirkycort.github.io/IoTy/public/firmware/';
const files = [
  'boot.py',
  'ioty/ble.mpy',
  'ioty/constants.mpy',
  'ioty/http.mpy',
  'ioty/monitor.mpy',
  'ioty/monitor_mqtt.mpy',
  'ioty/mqtt.mpy',
  'ioty/pin.mpy',
  'ioty/html/index.html',
  'umqtt/robust.mpy',
  'umqtt/simple.mpy'
];
const chunkSize = 256;
const chunkDelay = 10;

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

  // Run on page load
  this.init = function() {
    self.baudrateSelect = document.getElementById('baudrate');
    self.connectBtn = document.getElementById('connect');
    self.filteredConnectBtn = document.getElementById('filteredConnect');
    self.flashMicropythonBtn = document.getElementById('flashMicropython');
    self.flashIoTyBtn = document.getElementById('flashIoTy');
    self.deviceNameInput = document.getElementById('deviceName');
    self.noWebSerial = document.getElementById('noWebSerial');

    self.connectBtn.addEventListener('click', self.connect);
    self.filteredConnectBtn.addEventListener('click', self.filteredConnect);
    self.flashMicropythonBtn.addEventListener('click', self.flashMicropython);
    self.flashIoTyBtn.addEventListener('click', self.flashIoTy);

    if ('serial' in navigator) {
      this.downloadFirmware();
    } else {
      terminal.writeLine('Web Serial not supported on this browser!');
      self.noWebSerial.classList.remove('hide');
    }
  }

  this.downloadFirmware = async function() {
    terminal.write('Preloading firmware. Wait for completion before connecting... ');
    let response = await fetch('firmware-1.19.1.espnow.bin');
    let bytes = await response.arrayBuffer();
    self.firmware = bufferToString(bytes);

    self.firmwareMPY = {};
    for (let file of files) {
      let response = await fetch(firmwarePath + file);
      let bytes = await response.arrayBuffer();
      self.firmwareMPY[file] = { content: new Uint8Array(bytes) };
    }
    terminal.writeLine('Done');
    terminal.writeLine('You can connect and flash your ESP32 now.');
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
      terminal.writeLine('Serial port connected');
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

      await self.esploader.main_fn();

      await awaitTimeout(1000);

      await self.esploader.erase_flash();

      let fileArray = [{
        data: self.firmware,
        address: 0x1000
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
    } catch (error) {
      terminal.writeLine(error);
    }

    self.port.close();
  }

  this.flashIoTy = async function() {
    let deviceName = self.deviceNameInput.value;
    deviceName = deviceName.trim();
    if (deviceName == '') {
      terminal.writeLine('Device name cannot be empty');
      return;
    }
    if (deviceName.length > 8) {
      terminal.writeLine('Device name cannot exceed 8 characters');
      return;
    }

    try {
      await self.openPort();
    } catch (error) {
      terminal.writeLine(error);
      return;
    }

    let r;
    terminal.write('Terminating running program... ');
    self.clearBuf();
    self.sendCtrlC();
    r = await self.waitForString('>>> ');
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

    terminal.write('Formating filesystem... ');
    if (await self.formatFilesystem() != 'success') {
      await self.closePort();
      return;
    }
    terminal.writeLine('Done');

    terminal.write('Creating directories... ');
    if (await self.createDirectories(directories) != 'success') {
      await self.closePort();
      return;
    }
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

  this.openPort = async function() {
    await self.port.open({ baudRate: 115200 });
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