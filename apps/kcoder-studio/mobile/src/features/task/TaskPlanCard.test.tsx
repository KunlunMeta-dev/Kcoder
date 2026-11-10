import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, test, vi } from "vitest";
import { initLocale } from "@/i18n";
import { TodoCard } from "./TaskPlanCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("lucide-react-native", () => Object.fromEntries(["Check", "ChevronDown", "ChevronRight", "ListTodo"].map(name => [name, () => null])));

const todos = [
  { content: "Finished", status: "completed" as const },
  { content: "Cancelled", status: "cancelled" as const },
  { content: "Waiting", status: "pending" as const },
  { content: "Working", status: "in_progress" as const },
];
const toggle = (renderer: ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props.testID === id && typeof node.props.onPress === "function")[0];
const renderedText = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.type === "string")
  .map(node => node.children.filter(child => typeof child === "string").join("")).join("\n");

test.each([false, true])("current=%s uses the same completion count and explicitly identifies cancelled tasks", async current => {
  initLocale("en");
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<TodoCard todos={todos} current={current} />); });
  expect(JSON.stringify(renderer.toJSON())).toContain("1/4 completed");
  expect(renderedText(renderer)).toContain("In progress · Working");
  await act(async () => toggle(renderer, current ? "task-plan-summary" : "todo-card-toggle").props.onPress());
  const text = JSON.stringify(renderer.toJSON());
  for (const label of ["Completed", "Cancelled", "Pending", "In progress"]) expect(text).toContain(label);
  const list = renderer.root.findAll(node => node.props.testID === (current ? "task-plan-items" : "todo-card-items"))[0];
  if (current) expect(list.props.style.maxHeight).toBe(144);
  await act(async () => renderer.unmount());
});
