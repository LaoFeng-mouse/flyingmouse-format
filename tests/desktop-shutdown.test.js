const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { test } = require('node:test');
const { createDesktopShutdown, captureRuntimeIdentity, cleanupOwnedRuntime, PENDING_CLEANUP_FILE } = require('../desktop-shutdown');
const { createOwnedTaskRegistry } = require('../owned-tasks');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function entryFixture({ cli = false, fail = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const events = [], handlers = new Map(), windows = [];
  const app = { isPackaged:false, getVersion:()=> 'test', getPath:()=> 'C:/audit-profile',
    whenReady:()=>Promise.resolve(), requestSingleInstanceLock:()=>true,
    releaseSingleInstanceLock:()=>events.push('release-lock'),
    on:(event,fn)=>handlers.set(event,fn), quit(){}, exit:code=>events.push(['exit',code]),
    disableHardwareAcceleration(){},setAppUserModelId(){},
    commandLine:{hasSwitch:()=>false,getSwitchValue:()=>'',appendSwitch(){}} };
  class Window extends EventEmitter {
    constructor(){super();windows.push(this);this.webContents=new EventEmitter();this.webContents.session={setProxy:async()=>{},closeAllConnections:async()=>{}};}
    isDestroyed(){return Boolean(this.destroyed);} loadURL(){return Promise.resolve();}
    destroy(){this.destroyed=true;this.emit('closed');} static getAllWindows(){return windows.filter(w=>!w.destroyed);}
  }
  const server={listening:true,close(){this.listening=false;events.push('server-close');},closeAllConnections(){events.push('connections-close');}};
  const overrides={electron:{app,BrowserWindow:Window,shell:{},ipcMain:{handle(){}},dialog:{}},
    './logger':{setLogFile(){},getLogFile:()=> 'debug.log',info(){},warn(){},error(){}},
    './office-readiness':{startOfficePreparation:async()=>{}},
    './cli':{runCli:async()=>{events.push('cli-complete');if(fail)throw new Error('fixture CLI failure');return 0;}},
    './owned-tasks':{stopAll:async()=>{events.push('tasks-stop');return[];}},
    './desktop-shutdown':{createDesktopShutdown,captureRuntimeIdentity:async()=>({}),cleanupOwnedRuntime:async()=>events.push('async-cleanup')},
    './server':{startServer:async()=>({server,url:'http://127.0.0.1:5555'}),purgeRuntimeDirsSync:()=>events.push('sync-delete')}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'electron-main.js'),'utf8'),{
    __dirname:root,console:{log(){},error(){}},setImmediate,
    process:{argv:cli?['--cli','targets','png']:[],env:{},platform:'win32',pid:123,resourcesPath:'C:/audit-resources',on(){}},
    require:name=>Object.hasOwn(overrides,name)?overrides[name]:name.startsWith('./')?require(path.join(root,name)):require(name)
  });
  await settle();
  return {events,handlers};
}

test('actual desktop entry closes service and cancels owned work without synchronous directory deletion', async () => {
  const {events,handlers}=await entryFixture();
  let prevented=false;
  handlers.get('before-quit')({preventDefault(){prevented=true;}});
  assert.equal(events.includes('sync-delete'),false,'recursive deletion must not block the Electron main thread');
  assert.equal(prevented,true);
  assert.ok(events.indexOf('release-lock')>=0);
  assert.ok(events.indexOf('server-close')>=0);
  assert.ok(events.indexOf('connections-close')>=0);
  await settle();
  assert.ok(events.includes('async-cleanup'));
  assert.deepEqual(events.filter(e=>Array.isArray(e)),[['exit',0]]);
});

for(const fail of [false,true])test(`CLI entry stops its own helper before exit and retains its result code (${fail})`, async () => {
  const {events}=await entryFixture({cli:true,fail});await settle();
  const stop=events.indexOf('tasks-stop'),exit=events.findIndex(event=>Array.isArray(event)&&event[0]==='exit');
  assert.ok(stop>events.indexOf('cli-complete'),'CLI completion must cancel its preparation helper');
  assert.ok(exit>stop,'exit must follow owned task shutdown');
  assert.deepEqual(events[exit],['exit',fail?1:0]);
  assert.equal(events.includes('async-cleanup'),false,'CLI owns and disposes a separate workspace');
});

test('shutdown is reentrant, releases the instance lock immediately and does not wait forever', async () => {
  const events=[];
  let finishTasks;
  const shutdown=createDesktopShutdown({app:{releaseSingleInstanceLock:()=>events.push('release'),exit:code=>events.push(['exit',code])},
    stopTasks:()=>new Promise(resolve=>{events.push('cancel');finishTasks=resolve;}),
    closeServer:()=>events.push('server'),closeWindows:()=>shutdown.beforeQuit({preventDefault(){}}),
    cleanup:async()=>events.push('cleanup'),deadlineMs:25});
  shutdown.beforeQuit({preventDefault(){events.push('prevent');}});
  shutdown.beforeQuit({preventDefault(){}});
  assert.deepEqual(events,['prevent','release','cancel','server']);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(events.filter(e=>Array.isArray(e)),[['exit',0]]);
  finishTasks([]);await shutdown.completion();
  assert.equal(events.includes('cleanup'),false,'do not start deleting files after exit was committed');
  assert.equal(events.filter(e=>e==='cancel').length,1);
});

test('owned runtime cleanup preserves linked external data and refuses foreign PID roots', async t => {
  const parent=await fsp.mkdtemp(path.join(os.tmpdir(),'fm-shutdown-boundary-'));
  t.after(()=>fsp.rm(parent,{recursive:true,force:true}));
  const runtime=path.join(parent,`flyingmouse-format-runtime-${process.pid}`);
  const external=path.join(parent,'user-files');await fsp.mkdir(runtime);await fsp.mkdir(external);
  await fsp.writeFile(path.join(external,'keep.txt'),'user data');
  await fsp.symlink(external,path.join(runtime,'linked-user-files'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(captureRuntimeIdentity({runtimeDir:external,temporaryRoot:parent}),/Refused/);
  await cleanupOwnedRuntime(await captureRuntimeIdentity({runtimeDir:runtime,temporaryRoot:parent}));
  assert.equal(await fsp.readFile(path.join(external,'keep.txt'),'utf8'),'user data');
  await assert.rejects(fsp.stat(runtime),{code:'ENOENT'});
  await fsp.symlink(external,runtime,process.platform==='win32'?'junction':'dir');
  await assert.rejects(captureRuntimeIdentity({runtimeDir:runtime,temporaryRoot:parent}),/linked/);
});

test('cleanup refuses a replaced owned directory and never follows an existing marker hardlink', async t => {
  const parent=await fsp.mkdtemp(path.join(os.tmpdir(),'fm-shutdown-identity-'));
  t.after(()=>fsp.rm(parent,{recursive:true,force:true}));
  const runtime=path.join(parent,`flyingmouse-format-runtime-${process.pid}`);
  const owner=await captureRuntimeIdentity({runtimeDir:runtime,temporaryRoot:parent});
  await fsp.rename(runtime,`${runtime}-original`);await fsp.mkdir(runtime);
  const external=path.join(parent,'user-file');await fsp.writeFile(external,'KEEP');
  await assert.rejects(cleanupOwnedRuntime(owner),/changed/);
  const replacement=await captureRuntimeIdentity({runtimeDir:runtime,temporaryRoot:parent});
  await fsp.link(external,path.join(runtime,PENDING_CLEANUP_FILE));
  await assert.rejects(cleanupOwnedRuntime(replacement),{code:'EEXIST'});
  assert.equal(await fsp.readFile(external,'utf8'),'KEEP');
});

test('failed task termination defers runtime deletion', async () => {
  let deleted=false;
  const shutdown=createDesktopShutdown({app:{exit(){}},stopTasks:async()=>[{status:'rejected',reason:new Error('busy')}],
    closeServer(){},cleanup:async()=>{deleted=true;}});
  shutdown.beforeQuit({preventDefault(){}});await shutdown.completion();
  assert.equal(deleted,false);
});

test('the deferred-cleanup marker remains until all large child directories are removed', async t => {
  const parent=await fsp.mkdtemp(path.join(os.tmpdir(),'fm-shutdown-marker-'));
  t.after(()=>fsp.rm(parent,{recursive:true,force:true}));
  const owner=await captureRuntimeIdentity({runtimeDir:path.join(parent,`flyingmouse-format-runtime-${process.pid}`),temporaryRoot:parent});
  const folder=path.join(owner.runtimeDir,'converted');await fsp.mkdir(folder);
  const remove=fsp.rm;let release,removing;
  const entered=new Promise(resolve=>{removing=resolve;});
  fsp.rm=async(target,options)=>{if(target===folder){removing();await new Promise(resolve=>{release=resolve;});}return remove(target,options);};
  let cleanup;
  try {
    cleanup=cleanupOwnedRuntime(owner);
    const result=await Promise.race([entered.then(()=>true),cleanup.then(()=>false)]);
    assert.equal(result,true,'remove owned children first; do not recursively erase the root marker early');
    assert.equal(fs.existsSync(path.join(owner.runtimeDir,PENDING_CLEANUP_FILE)),true);
  }finally{release?.();await cleanup;fsp.rm=remove;}
});

test('shutdown also waits for tasks registered while its first cancellation batch settles', async () => {
  const registry=createOwnedTaskRegistry();
  let releaseFirst,releaseLate,finished=false;
  registry.track(()=>new Promise(resolve=>{releaseFirst=resolve;}));
  const pending=registry.stopAll().then(()=>{finished=true;});
  await settle();
  registry.track(()=>new Promise(resolve=>{releaseLate=resolve;}));
  await settle();releaseFirst();await settle();
  assert.equal(finished,false,'late cancellation must finish before cleanup begins');
  releaseLate();await pending;
});

test('stopping a registry terminates its real child and grandchild while an unrelated child survives', async t => {
  const registry=createOwnedTaskRegistry();
  const child=spawn(process.execPath,['-e',`const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'pipe'});process.stdout.write(c.pid+'\\n');setInterval(()=>{},1000);`],
    {windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'});
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'pipe'});
  t.after(async()=>{
    unrelated.kill();
    if(child.exitCode===null&&child.signalCode===null){
      if(process.platform==='win32')await new Promise(resolve=>execFile(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve()));
      else try{process.kill(-child.pid,'SIGKILL');}catch{}
    }
  });
  const exited=once(child,'close');
  const grandchild=await new Promise(resolve=>child.stdout.once('data',chunk=>resolve(Number(String(chunk).trim()))));
  registry.trackProcess(child,{processGroup:process.platform!=='win32'});
  const stopped=await registry.stopAll();
  assert.ok(stopped.every(result=>result.status==='fulfilled'),JSON.stringify(stopped.map(result=>result.reason&&{message:result.reason.message,code:result.reason.code,signal:result.reason.signal,killed:result.reason.killed})));
  await exited;
  assert.throws(()=>process.kill(grandchild,0),{code:'ESRCH'});
  assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
  assert.throws(()=>registry.assertAccepting(),{code:'CONVERSION_CANCELED'});
});
