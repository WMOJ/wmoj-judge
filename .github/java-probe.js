// TEMPORARY (removed before merge): measures what each JVM needs under the
// real jail on an amd64 kernel, so languages.json's numbers are measured.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const table = JSON.parse(fs.readFileSync("/app/languages.json", "utf8"));

const HELLO = `public class Main { public static void main(String[] a){ System.out.println("hi"); } }`;
const HEAVY = (mb) => `
import java.util.*; import java.math.BigInteger;
public class Main {
  static long depth(int n){ return n==0?0:1+depth(n-1); }
  public static void main(String[] a) throws Exception {
    long[][] held = new long[${mb}][]; for (int i=0;i<held.length;i++){ held[i]=new long[1<<17]; held[i][0]=i; }
    HashMap<Integer,Integer> m = new HashMap<>(); for (int i=0;i<200000;i++) m.put(i,i);
    Thread[] ts = new Thread[4]; for (int i=0;i<4;i++){ ts[i]=new Thread(()->{ depth(1000); }); ts[i].start(); } for (Thread t: ts) t.join();
    StringBuilder sb = new StringBuilder(); for (int i=0;i<100000;i++) sb.append(i);
    BigInteger b = BigInteger.ONE; for (int i=1;i<2000;i++) b=b.multiply(BigInteger.valueOf(i));
    long s=0; for (int i=0;i<200000000;i++) s+=i%7;
    System.out.println(depth(1000000)+" "+held.length+" "+m.size()+" "+sb.length()+" "+b.bitLength()+" "+s);
  }
}`;

function jail(cwd, asMb, argv, seccomp = true, cpu = 20) {
  const nsjail = [
    "--mode","o","--disable_clone_newuser","--disable_clone_newnet","--disable_clone_newns",
    "--disable_clone_newpid","--disable_clone_newipc","--disable_clone_newuts","--disable_clone_newcgroup",
    "--keep_caps","--cwd",cwd,"--rlimit_as",String(asMb),"--rlimit_cpu",String(cpu),
    "--rlimit_nproc","256","--rlimit_nofile","256","--rlimit_fsize","10","--rlimit_core","0",
    ...(seccomp ? ["--seccomp_policy","/app/policy.kafel"] : []),
    "--env","PATH","--env","LANG","--env","LC_ALL","--env","PYTHONUNBUFFERED",
    "--time_limit","40","--log_fd","3","--",...argv,
  ];
  const r = spawnSync("/usr/local/bin/wmoj-jailrun", ["4","/usr/local/bin/nsjail",...nsjail], {
    cwd, input: "", stdio: ["pipe","pipe","pipe","pipe","pipe"], timeout: 60000,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONUNBUFFERED: "1" },
  });
  const out = (r.output || []).map((b) => (b ? b.toString() : ""));
  const rep = /cpu_us=(\d+) maxrss_kb=(\d+) wall_us=(\d+)/.exec(out[4] || "");
  return {
    exit: r.status, cpuMs: rep ? Math.round(rep[1]/1000) : null, rssMb: rep ? Math.round(rep[2]/1024) : null,
    wallMs: rep ? Math.round(rep[3]/1000) : null,
    stdout: (out[1]||"").trim().slice(0,120), stderr: (out[2]||"").trim().split("\n").slice(0,3).join(" | ").slice(0,300),
    log: r.status === 0 ? "" : (out[3]||"").split("\n").filter((l)=>/\[(W|E|F)\]/.test(l)).slice(0,2).join(" | ").slice(0,200),
  };
}
function compile(spec, dir, src, argvOverride) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Main.java"), src);
  const argv = argvOverride || spec.compile.argv;
  const t = process.hrtime.bigint();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  const ms = Number((process.hrtime.bigint() - t) / 1000000n);
  return { ms, status: r.status, out: (r.stdout+""+r.stderr).trim().slice(0,400), ru: process.resourceUsage ? undefined : undefined };
}
const runArgv = (spec, heap) => spec.run.map((a) => a.replace("<HEAP_MB>", String(heap)));

console.log("cpus", os.cpus().length, "mem", Math.round(os.totalmem()/1048576), "MB");
for (const v of ["11","17","21"]) {
  const spec = table["java"+v];
  const home = "/opt/java/"+v;
  console.log(`\n===== java${v} =====`);
  for (const f of ["lib/modules","lib/server/classes.jsa","lib/server/javac.jsa","lib/server/libjvm.so"]) {
    try { console.log(f, Math.round(fs.statSync(path.join(home,f)).size/1048576)+" MB"); } catch { console.log(f, "MISSING"); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const noArchive = spec.compile.argv.filter((a) => !a.includes("SharedArchiveFile"));
  for (let i=0;i<2;i++) console.log("javac hello (spec)      ", JSON.stringify(compile(spec, dir, HELLO)));
  for (let i=0;i<2;i++) console.log("javac hello (no javac.jsa)", JSON.stringify(compile(spec, dir, HELLO, noArchive)));
  console.log("javac hello (no -J flags)", JSON.stringify(compile(spec, dir, HELLO, [spec.compile.argv[0], "-d","classes","Main.java"])));
  compile(spec, dir, HELLO);
  console.log("-- hello, Xmx192, by --rlimit_as");
  for (const as of [384,448,512,576,640,704,768,896,1024,2048]) console.log(as, JSON.stringify(jail(dir, as, runArgv(spec,192))));
  console.log("hello no-seccomp as=1024", JSON.stringify(jail(dir, 1024, runArgv(spec,192), false)));
  console.log("hello Xshare:off as=1024", JSON.stringify(jail(dir, 1024, runArgv(spec,192).map((a)=>a==="-XX:-UsePerfData"?"-Xshare:off":a))));
  console.log("hello no ARENA_MAX as=1024", JSON.stringify(jail(dir, 1024, runArgv(spec,192).slice(2))));
  console.log("hello no ARENA_MAX as=4096", JSON.stringify(jail(dir, 4096, runArgv(spec,192).slice(2))));
  console.log("-- heavy(150MB), Xmx192, by --rlimit_as");
  console.log("javac heavy", JSON.stringify(compile(spec, dir, HEAVY(150))));
  for (const as of [448,512,576,640,704,768,896,1024,2048]) console.log(as, JSON.stringify(jail(dir, as, runArgv(spec,192))));
  console.log("-- heavy(280MB), Xmx320, by --rlimit_as");
  compile(spec, dir, HEAVY(280));
  for (const as of [576,640,704,768,832,896,1024,1152,2048]) console.log(as, JSON.stringify(jail(dir, as, runArgv(spec,320))));
  console.log("-- heavy(400MB) Xmx192 as=1024 (expect OutOfMemoryError)");
  compile(spec, dir, HEAVY(400));
  console.log(JSON.stringify(jail(dir, 1024, runArgv(spec,192))));
}
