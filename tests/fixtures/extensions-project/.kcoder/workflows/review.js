return await phase("review", async () => {
  const output = await agent({
    prompt: `审查 ${args.target}`,
    agentType: "reviewer",
    maxTurns: 7,
    acceptanceCriteria: ["返回结构化结论"],
    contextPaths: [args.target]
  });
  return {
    ok: true,
    target: args.target,
    output
  };
});
