import { afterEach, expect, it, vi } from "vitest";
import { isWidgetRef, type WidgetRef } from "../../../shared/generated/contracts";
import { TaskRuntime, taskRuntimeTestHelpers } from "./task-runtime";
import { FakeClient, profile, server } from "./task-runtime/fixture.test-support";
import type { ThreadMessage } from "@/gateway/types";
vi.mock("@/gateway/http", () => ({ ensureGatewayAuthorization: vi.fn(async () => {}), gatewaySessionExpired: vi.fn(async () => false) }));
afterEach(() => { taskRuntimeTestHelpers.resetConnector(); vi.restoreAllMocks(); vi.useRealTimers(); });
const widget: WidgetRef = { widgetId:"widget",threadId:"thread-1",turnId:"turn",attemptId:"attempt",toolCallId:"call",revision:1,title:"Diagram",summary:"Source to result",format:"svg",executionMode:"managed",libraries:[],bytes:6,sha256:"a".repeat(64),createdAtMs:1 };
it("new widget metadata and Studio mode fields preserve Mobile history and terminal tool states", async () => {
  expect(isWidgetRef(widget)).toBe(true);
  const output = JSON.stringify({ widget_id:widget.widgetId,revision:1,title:widget.title,summary:widget.summary });
  const history = [{id:"assistant",role:"assistant",content:'Result\n::kcoder-widget{widget_id="widget" revision=1}',timestampMs:1,status:"completed",studioWorkMode:"kworker",futureExtension:{version:2},
    blocks:[{id:"call",type:"tool",tool_name:"show_widget",status:"done",tool_output:output,widgetRef:widget,futureField:true}]}] as unknown as ThreadMessage[];
  const client = new FakeClient(history);
  taskRuntimeTestHelpers.setConnector(vi.fn(async()=>client as never) as never);
  const runtime = await TaskRuntime.resume({profile,server,threadId:"thread-1"});
  try {
    const row = runtime.getSnapshot().messages[0];
    expect(row.content).toContain("Result");
    expect(row.tools?.[0]).toMatchObject({name:"show_widget",status:"completed",output});
    expect(client.supportsExperimental("inlineWidgetsV1")).toBe(false);
  } finally { runtime.close(); }
});
it("unknown visualization previews stay out of text while normal incremental output and terminal settlement continue", async () => {
  vi.useFakeTimers();
  const client = new FakeClient([]);
  taskRuntimeTestHelpers.setConnector(vi.fn(async()=>client as never) as never);
  const runtime = await TaskRuntime.resume({profile,server,threadId:"thread-1"});
  try {
    client.emit({method:"turn/started",params:{threadId:"thread-1",turnId:"turn",attemptId:"attempt",turn:{id:"turn",status:"running"}}});
    client.emit({method:"item/event",params:{threadId:"thread-1",turnId:"turn",event:{type:"widget_input_preview",id:"call",preview:{source:"PRIVATE_UI_SOURCE",bytes:17,format:"svg",complete:false,truncated:false}}}});
    client.emit({method:"item/started",params:{threadId:"thread-1",turnId:"turn",item:{id:"call",type:"toolCall",name:"show_widget",input:{title:"Figure"}}}});
    client.emit({method:"item/completed",params:{threadId:"thread-1",turnId:"turn",item:{id:"call",type:"toolCall",name:"show_widget",output:{summary:"Readable diagram summary"},widgetRef:widget}}});
    client.emit({method:"item/delta",params:{threadId:"thread-1",turnId:"turn",itemId:"answer",delta:{text:"Final readable answer"}}});
    client.emit({method:"turn/completed",params:{threadId:"thread-1",turnId:"turn",turn:{id:"turn",attemptId:"attempt",status:"completed"}}});
    await vi.runAllTimersAsync();
    const rows = runtime.getSnapshot().messages;
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_UI_SOURCE");
    expect(rows.at(-1)?.content).toContain("Final readable answer");
    expect(rows.at(-1)?.status).toBe("completed");
    expect(rows.at(-1)?.tools?.[0].status).toBe("completed");
    expect(runtime.getSnapshot().running).toBe(false);
  } finally { runtime.close(); }
});
