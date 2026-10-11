import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { waitFor } from "../../harness/run-context.mjs";
import { runRealWorkflowCases } from "../../harness/real-workflow-cases.mjs";

const deterministic = process.env.KCODER_E2E_WORKFLOW_DETERMINISTIC !== "0";
const deterministicPrompt = `实际测试并按需修复 Python 项目，输入 {project_dir,report_file,mode}，路径相对工作目录，三者必填，mode 任意string，无enum。total(rows) 必须等于 sum(qty*price)，不能修改测试文件。
必须以确定性工具执行测试、提取真实结果和写报告，仅 repair 节点允许Agent。
节点：test_command(code) 生成只读 Python 测试命令；baseline_run(tool bash)执行；baseline(code)解析JSON报告；router(switch)选repair/audit/default skip；repair(agent)按需修 calculator.py，audit(code)、skip(code)均返回 {changed:false}；join(merge any)；verify_run(tool bash)依赖join,test_command重跑同一测试命令；verify(code)解析真实结果；publish(code)组成报告；write_file(tool write)写文件；verify_file(tool read)读取实际报告并resultCheck对比；output。
测试命令使用 python3 -B 加单引号 heredoc。Python 中以 unittest.TestLoader().discover(project_dir) 加 unittest.TestResult 执行测试，suite.run(result)，打印单行 KCODER_TEST_RESULT= 加 JSON {passed:result.wasSuccessful(),testCount:result.testsRun}。测试断言失败是要报告的数据，命令本身正常返回；语法错误等基础设施故障要让命令失败。不要用虚假的固定结果。project_dir 用 Code 的 JSON.stringify 生成安全 Python 字符串字面量放入引用heredoc，不能直接拼进shell命令参数。read/write分别使用 file_path、content；read arguments={format:'raw'} 返回原文。
Tool 输出 {content:[{type:'text',text:...}],isError:false}，Bash 文本带命令状态和 stdout 标题；Code 找实际以 KCODER_TEST_RESULT= 开头的一行再 JSON.parse，必须验证 passed 是bool、testCount是正整数，找不到就throw。生成Code或resultCheck是函数体，必须顶层return，不能只定义一个未调用函数。对换行/TAB优先用 String.fromCharCode，避免node_json双层转义错误。
baseline 返回 {initialPassed,testCount}，verify 返回 {finalPassed,testCount}。repair 依赖 router,baseline 且guard=repair，必须为repair配置对象outputSchema，required changed:boolean，additionalProperties:false，最终只返回JSON对象不要标记。allowedWritePaths只使用字面路径cases（本测试授权范围），不能发明\${project_dir}模板。只在 initialPassed=false 时读取并修复指定 project_dir/calculator.py，不能改其它项目或测试文件；无需在Agent中重复运行测试或报告最后通过状态，那由verify_run完成。initialPassed=true不编辑，返回 {changed:false}。audit/skip用Code返回{changed:false}。
publish只消费baseline/join/verify真实依赖，payload恰好 {mode,initialPassed,finalPassed,changed,testCount}；不认识的mode输出skip，changed取join唯一分支，testCount取verify。输出 {payload,content:JSON.stringify(payload)}。resultCheck核对payload与依赖逐项一致，repair路由必须finalPassed=true，其它路由不要求通过但应保持baseline和verify结论一致。最终 write_file 用bindings接入report_file/content，verify_file读取原文JSON并resultCheck与publish.payload相等。output=/nodes/publish/payload，必须依赖verify_file,publish。
所有关键依赖值都用config.inputBindings声明并从bindings取值；不存在隐式output包装。三分支guard不能丢失，保留直接依赖；不要把整个流程塞进Agent或一个shell脚本。每个节点用node_json提交。`;

await runRealWorkflowCases(import.meta.url, {
  deterministic,
  tier: "credentialed-integration",
  modelPolicy: "real-model-required",
  repair: deterministic ? "仅修publish.resultCheck中的业务校验，其它已通过的节点和代码保持不变。当前未知input.mode正确路由到skip，publish.payload.mode也正确输出skip，但resultCheck错用 payload.mode !== input.mode，导致默认分支误失败。应验证payload.mode === routeId（repair/audit/否则skip），不是原始未知值。保留changed与join实际分支、initialPassed/finalPassed/testCount与真实依赖、content与payload逐字段一致的检查；repair必须最终通过，audit/skip初始和最终测试结论应相同。对于本任务，repair且初始失败最终通过时changed必须true，初始通过时changed必须false。不能移除resultCheck、改预期答案或恒返回true。只patch这一段，read确认后保存新版本。" :
    "修订导入流程：上一次把参数错误包装在 input.args 下，导致 repair 输入走 skip。正确 inputSchema 顶层字段是 project_dir,report_file,mode，required 三者，router 比较 /input/mode。每个分支给完整具体提示词，不能只写 Skip branch；输出Schema 必须声明字段和required，skip/audit 恰好返回 {changed:false}。所有 Agent maxTurns 提高到12。",
  name: deterministic ? "code-repair-deterministic" : "code-repair",
  validateDefinition: deterministic ? definition => {
    assert.ok(definition.nodes.filter(node => !node.kind || node.kind === "agent").every(node => node.id === "repair"), "only the repair task may require a model Agent");
    assert.ok(definition.nodes.some(node => node.id === "verify_run" && node.kind === "tool"), "test results must come from an executed tool");
    assert.ok(definition.nodes.some(node => node.id === "verify_file" && node.config?.resultCheck), "read back and check the actual report");
  } : undefined,
  nodeIds: [
    "baseline",
    "router",
    "repair",
    "audit",
    "skip",
    "join",
    "verify",
    "publish",
    "output",
  ],
  prompt: deterministic ? deterministicPrompt : `实际检查并按要求修复一个小型 Python 项目。输入 args={project_dir,report_file,mode}，路径均相对当前工作目录。项目包含 calculator.py 和 test_calculator.py，total(rows) 应计算 sum(qty*price)。只能在 mode=repair 且测试失败时修改该项目的 calculator.py；绝对不能改测试文件或其他项目。
baseline Agent 无依赖：实际运行 python3 -m unittest discover -s <project_dir> -p 'test_*.py'，用退出码判断通过，不要以 stderr 非空判断失败。返回 {initialPassed:bool,testCount:整数}。失败的测试是待报告的数据，不要在此节点修复。
router Switch 依赖 baseline，按 /input/mode 选择 repair、audit，默认 skip。mode inputSchema 是任意 string，无 enum。
repair Agent 依赖 router,baseline，guard=repair：initialPassed=true 时不修改代码；否则读取 calculator.py 和测试文件，修复 total 的乘法求和逻辑，只修改 calculator.py，再实际运行 unittest。返回 {changed:bool}。允许修改当前目录中的该项目代码。
audit Agent 依赖 router,baseline，guard=audit：只读，返回 {changed:false}。skip Agent 依赖 router，guard=skip：不修改，返回 {changed:false}。
join Merge any 依赖 repair,audit,skip。
verify Agent 依赖 join,baseline：再次实际运行相同 unittest，以退出码返回 {finalPassed:bool,testCount:整数}。audit/skip 遇到失败要如实 false，不允许改代码掩盖失败。
publish Agent 依赖 baseline,join,verify：只从真实依赖结果写 report_file，恰好 {mode,initialPassed,finalPassed,changed,testCount}；mode 为选中的 repair/audit/skip，join 是按源节点ID嵌套的对象，changed 从唯一选中分支取值。write 后返回相同 JSON。不得代替 verify 运行测试或改代码。
output 节点依赖 publish，pointer=/nodes/publish。共9节点。所有 Agent maxTurns=6。不要为了让 audit/skip 的失败测试变绿而修改文件。`,
  async prepare(_context, workspace) {
    const tests =
      'import unittest\nfrom calculator import total\n\nclass TotalTests(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(total([]), 0)\n    def test_single(self):\n        self.assertEqual(total([{\"qty\": 3, \"price\": 7}]), 21)\n    def test_multiple(self):\n        self.assertEqual(total([{\"qty\": 2, \"price\": 100}, {\"qty\": 3, \"price\": 20}]), 260)\n\nif __name__ == \"__main__\":\n    unittest.main()\n';
    const cases = [];
    const modes = [
      { name: "repair-bug", mode: "repair", broken: true },
      { name: "repair-clean", mode: "repair", broken: false },
      { name: "audit-bug", mode: "audit", broken: true },
      { name: "skip-bug", mode: "unknown", broken: true },
    ];
    for (let repeat = 0; repeat < 2; repeat++)
      for (const item of modes) {
        const name = item.name + (repeat ? "-repeat" : "");
        const dir = resolve(workspace, "cases", name);
        await mkdir(dir, { recursive: true });
        const source = `def total(rows):\n    return sum(row["qty"] ${item.broken ? "+" : "*"} row["price"] for row in rows)\n`;
        await writeFile(resolve(dir, "calculator.py"), source);
        await writeFile(resolve(dir, "test_calculator.py"), tests);
        cases.push({
          ...item,
          name,
          source,
          tests,
          args: {
            project_dir: `cases/${name}`,
            report_file: `cases/${name}/report.json`,
            mode: item.mode,
          },
        });
      }
    return cases;
  },
  async verify(context, workspace, sample, run) {
    const dir = resolve(workspace, sample.args.project_dir),
      mode = sample.mode === "unknown" ? "skip" : sample.mode;
    const expected = {
      mode,
      initialPassed: !sample.broken,
      finalPassed: !sample.broken || mode === "repair",
      changed: sample.broken && mode === "repair",
      testCount: 3,
    };
    const report = JSON.parse(
      await readFile(resolve(workspace, sample.args.report_file), "utf8"),
    );
    assert.deepEqual(report, expected);
    assert.equal(
      await readFile(resolve(dir, "test_calculator.py"), "utf8"),
      sample.tests,
      "test code must remain unchanged",
    );
    const source = await readFile(resolve(dir, "calculator.py"), "utf8");
    if (!expected.changed)
      assert.equal(source, sample.source, "unrequested code edits");
    const child = context.spawnOwned(
      `independent-unittest-${sample.name}`,
      "python3",
      ["-B", "-m", "unittest", "discover", "-s", dir, "-p", "test_*.py"],
      {
        cwd: dir,
        env: context.isolatedEnvironment({ PYTHONDONTWRITEBYTECODE: "1" }),
      },
    );
    await waitFor(
      () => child.exitCode !== null,
      15000,
      "independent unittest exit",
    );
    assert.equal(child.exitCode, expected.finalPassed ? 0 : 1);
    for (const id of ["repair", "audit", "skip"])
      assert.equal(
        run.nodeStates.find((node) => node.nodeId === id)?.status,
        id === mode ? "completed" : "skipped",
      );
    await context.writeArtifactJson(`artifact-${sample.name}.json`, {
      report,
      independentExitCode: child.exitCode,
      testsUnchanged: true,
      source,
    });
  },
});
