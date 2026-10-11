import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runRealWorkflowCases } from "../../harness/real-workflow-cases.mjs";

const deterministic = process.env.KCODER_E2E_WORKFLOW_DETERMINISTIC !== "0";
const deterministicPrompt = `实际读取 CSV、清洗、去重/保留全部有效行，并写 JSON 文件。必须采用确定性节点，不允许 Agent/Loop 节点，也不允许 Shell/Python 代替整张图。
输入顶层是 source_file,output_file,mode，都是字符串且必填；mode 不限制 enum。CSV 是 UTF-8，含带逗号的引号字段，列 id,name,qty,price。trim id/name，id 非空，qty 和 price 都必须是非负整数；否则该行无效。invalidCount 不包含表头或重复 id。
建立12个节点：read_file(tool read) → parse(code)、stats(code) → router(switch) → dedupe(transform)/all_rows(code)/reject(code) → join(merge any) → publish(code) → write_file(tool write) → verify_file(tool read) → output(output)。允许为真实数据依赖增加边：stats 依赖 parse；router 依赖 stats；dedupe/all_rows 依赖 router,parse；reject 依赖 router；publish 依赖 join,parse,stats；verify_file 依赖 write_file,publish；output 依赖 verify_file,publish。三分支 guard 分别 dedupe/all/reject。
工具约定：read 的参数是 file_path 和 format=raw（返回原文，无展示头和行号），必须使用 config.tool.bindings 从 /input/source_file 或 /input/output_file 传入，不设置 offset/limit。工具返回 {content:[{type:'text',text:...}],isError:false}，必须设置 tool.arguments={format:'raw'}，不要对原文添加或猜测展示头；不能把整段文本当文件名。write 参数是 file_path 和 content，均由 bindings 提供；content 是 JSON 字符串。
Code 接收 input,nodes,bindings；无文件系统、无 require、无 console。通过 config.inputBindings 声明必需数据，代码用 bindings.<name>，不要臆造 output 包装。parse 用真正支持 CSV 引号转义的解析器，保留顺序和重复 id；返回 {rows,invalidCount}。stats 根据 parse.rows 算校验统计。dedupe 使用 transform 的 deduplicate，pointer=/id，保留首条。all_rows 返回全部有效行 {rows}，dedupe 直接返回数组，reject 返回 {rows:[]}。publish 按 join 唯一分支取 rows（dedupe 分支是数组，其余是对象）；输出 {payload:{rows,count,invalidCount,total,route},content:JSON.stringify(payload)}。route 为 dedupe/all/reject，total=sum(qty*price)。只写 output_file，不改 source_file。
publish 的 resultCheck 必须验证 payload.count=rows.length、total 等于逐行乘法求和、invalidCount 与 parse 一致。verify_file 的 resultCheck 从 result.content 的 read 文本解码实际文件 JSON，并与 publish.payload 比较，失败抛错或返回 false。output pointer=/nodes/publish/payload。
有 outputSchema 时须声明引用所需的真实字段。每个节点用 node_json 无损 JSON 文本提交，避免嵌套字段被错误转型。Code/检查代码要处理空数组和中文，不要通过删掉分支、去掉验证或填固定答案通过。保存前检查全部依赖和字段路径。`;

await runRealWorkflowCases(import.meta.url, {
  deterministic,
  tier: "credentialed-integration",
  modelPolicy: "real-model-required",
  repair: deterministic ? "修订现有确定性图，保留12节点、依赖和guard，不引入Agent。read_file 和 verify_file 必须配置 config.tool.arguments={format:'raw'}，保留 tool.name 和 tool.bindings；raw 返回实际完整文本，没有 Contents of 标题/空行/行号。不要把默认展示文本直接当CSV/JSON。上次有两项真实问题：resultCheck.source 只定义 function check 而未调用，必须改成带顶层return的函数体（input,nodes,bindings,result 已由运行时传入）；CSV解析代码正则过度转义，实际匹配字面反斜线而不是换行/TAB。修正时避免多层JSON正则转义，优先用 String.fromCharCode(10)、String.fromCharCode(9)、字符比较和 Number.isInteger 处理。read返回行号+TAB前缀，只去掉首个TAB之前的行号。必须处理引号字段内逗号、中文、空行、重复id、非整数。非法表头必须throw，不能静默返回空数组。verify_file 的实际文件读取文本也要正确剥离行号后 JSON.parse。不要改期望值、放宽检查或删除校验，不要写入固定答案。按字段patch_nodes修订，再read核查并save新版本。" :
    "修订导入的真实生成流程：保持三个分支的 runIf 和 dependsOn 不变，若缺失必须恢复 dedupe/all_rows/reject 的 router guard=dedupe/all/reject。publish 必须调用 write 文件工具写 output_file，再 read 该文件核对内容后返回 JSON，不允许用 Bash/Python 写入文件（路径授权不允许这种绕过）。只能用 patch_nodes 修改这些字段，不要整节点重建。上一次 parse 输出包含解释性文字，不是纯JSON；还把 validationRetries 错放进 outputSchema 内，实际没有重试。parse/stats/dedupe/all_rows/publish 都允许通过 bash 调用只读 Python 计算；没有独立 python 工具，不能限制 no shell。invalidCount 只统计不满足字段校验的行，不含表头、空白行或重复 id；最终 JSON 必须原样使用计算工具的数值，不得自行重写计数。所有 config.outputSchema 必须有 type:object，config.validationRetries=2 必须与 outputSchema 同级，禁止放在JSON Schema内部。需要write的 publish 可用 Python/Bash，不能限制不存在的只读python工具。发布节点提示要取上下文里的数据，不把 /input/source_file 字面字符串当文件名。请把所有 Agent maxTurns 提高到12，保留节点和正确处理逻辑；publish 应直接从提供的节点输出构造 JSON，不读不存在的 parse/stats 文件。用一次 Python 运算核实后 write，再返回同一JSON。",
  name: deterministic ? "file-cleaning-deterministic" : "file-cleaning",
  validateDefinition: deterministic ? definition => {
    assert.ok(definition.nodes.every(node => ![undefined, "agent", "loop"].includes(node.kind)), "deterministic graph must not delegate data processing to model Agents");
    assert.ok(definition.nodes.some(node => node.id === "verify_file" && node.config?.resultCheck), "actual written artifact must have an executable check");
    assert.ok(definition.nodes.some(node => Object.keys(node.config?.inputBindings || {}).length > 0), "declare strict data bindings");
  } : undefined,
  nodeIds: [
    "parse",
    "stats",
    "router",
    "dedupe",
    "all_rows",
    "reject",
    "join",
    "publish",
    "output",
  ],
  prompt: deterministic ? deterministicPrompt : `任务是实际读取 CSV、清洗去重或保留全部有效行，输出 JSON 文件。输入 args={source_file,output_file,mode}。CSV 列是 id,name,qty,price，UTF-8，可能带中文和包含逗号的引号字段。
节点要求：
parse Agent：实际用 Python csv.DictReader 读取 source_file；trim id/name，qty/price 必须可转整数且非负，id 非空，否则该行无效。返回 {rows:[{id,name,qty,price}],invalidCount}，qty/price 为数值，保持有效行原顺序。
stats Agent：无依赖，与 parse 并行；独立实际读取源文件，以同样规则返回 {validCount,invalidCount,totalQty,rawTotal}。只能读取，不修改文件。
router Switch 依赖 parse,stats：mode=dedupe 走 dedupe，mode=all 走 all，默认 reject；inputSchema mode 不设 enum。
dedupe Agent 依赖 router,parse，runIf=dedupe：按 id 保留第一条，返回 {rows:[...]}; all_rows Agent 依赖 router,parse，runIf=all：返回全部有效行 {rows:[...]}; reject Agent 依赖 router，runIf=reject：返回 {rows:[]}。
join 是 Merge any，依赖 dedupe,all_rows,reject。
publish Agent 依赖 join,parse,stats：只消费真实依赖输出，不直接重读 CSV 绕过分支。以只读计算命令核实金额，取 join 唯一条目作为选中路由，写 args.output_file，文件恰好 {rows,count,invalidCount,total,route}；rows 为选中分支 rows，count=rows.length，invalidCount 来自 parse，total=sum(qty*price)，route 分别为 dedupe/all/reject（all_rows 对应 all）。之后返回同一 JSON。允许写当前工作目录下结果文件，不改原 CSV。
output 节点依赖 publish，pointer=/nodes/publish。共9个节点，Agent maxTurns=6。`,
  async prepare(_context, workspace) {
    const fixtures = [
      {
        name: "dedupe",
        mode: "dedupe",
        text: "id,name,qty,price\na, Alice ,2,10\na, Later ,4,20\nb,Bob,3,5\nc,Bad,-1,10\n",
        rows: [
          { id: "a", name: "Alice", qty: 2, price: 10 },
          { id: "b", name: "Bob", qty: 3, price: 5 },
        ],
        invalid: 1,
      },
      {
        name: "all",
        mode: "all",
        text: "id,name,qty,price\na, Alice ,2,10\na, Later ,4,20\nb,Bob,3,5\nc,Bad,-1,10\n",
        rows: [
          { id: "a", name: "Alice", qty: 2, price: 10 },
          { id: "a", name: "Later", qty: 4, price: 20 },
          { id: "b", name: "Bob", qty: 3, price: 5 },
        ],
        invalid: 1,
      },
      {
        name: "unicode",
        mode: "dedupe",
        text: 'id,name,qty,price\nx," 张三,团队 ",2,15\ny,李四,0,7\nz,错误,2.5,10\n',
        rows: [
          { id: "x", name: "张三,团队", qty: 2, price: 15 },
          { id: "y", name: "李四", qty: 0, price: 7 },
        ],
        invalid: 1,
      },
      {
        name: "fallback",
        mode: "unrecognized",
        text: "id,name,qty,price\na,Alice,1,10\n",
        rows: [],
        invalid: 0,
      },
    ];
    const cases = [];
    for (let repeat = 0; repeat < 2; repeat++)
      for (const fixture of fixtures) {
        const name = fixture.name + (repeat ? "-repeat" : "");
        const dir = resolve(workspace, "cases", name);
        await mkdir(dir, { recursive: true });
        await writeFile(resolve(dir, "input.csv"), fixture.text);
        cases.push({
          ...fixture,
          name,
          args: {
            source_file: `cases/${name}/input.csv`,
            output_file: `cases/${name}/result.json`,
            mode: fixture.mode,
          },
        });
      }
    return cases;
  },
  async verify(context, workspace, sample, run) {
    const artifact = JSON.parse(
      await readFile(resolve(workspace, sample.args.output_file), "utf8"),
    );
    const route =
      sample.mode === "dedupe"
        ? "dedupe"
        : sample.mode === "all"
          ? "all"
          : "reject";
    assert.deepEqual(artifact, {
      rows: sample.rows,
      count: sample.rows.length,
      invalidCount: sample.invalid,
      total: sample.rows.reduce((sum, row) => sum + row.qty * row.price, 0),
      route,
    });
    assert.equal(
      await readFile(resolve(workspace, sample.args.source_file), "utf8"),
      sample.text,
    );
    const active = route === "all" ? "all_rows" : route;
    for (const id of ["dedupe", "all_rows", "reject"])
      assert.equal(
        run.nodeStates.find((node) => node.nodeId === id)?.status,
        id === active ? "completed" : "skipped",
      );
    await context.writeArtifactJson(`artifact-${sample.name}.json`, artifact);
  },
});
