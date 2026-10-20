  if (action === "buy" || action === "swap") {
    // Acute stress vetoes entries; it never vetoes exits.
    if (stress > 0.5) return null;
  }
  if (action === "swap") {
    const tin = choiceOf(answers, AI_QID.swapTokenIn);
    const tout = choiceOf(answers, AI_QID.swapTokenOut);
    if (!tin || !tout || tin.choice === tout.choice) return null;
    params.tokenIn = tin.choice;
    params.tokenOut = tout.choice;
    judgments.push(
      { qid: AI_QID.swapTokenIn, confidence: tin.confidence },
      { qid: AI_QID.swapTokenOut, confidence: tout.confidence },
    );
    rationale.push(`${tin.choice}→${tout.choice}`);
  }
  rationale.push(`exec_ok=${execOk.toFixed(2)}`, `stress=${stress.toFixed(2)}`);

  let weakest = judgments[0]!;
  for (const j of judgments) if (j.confidence < weakest.confidence) weakest = j;

  return {
    action,
    params,
    confidence: weakest.confidence,
    weakest: weakest.qid,
    answers,
    rationale: rationale.join(" · "),
    fetchedAt: Date.now(),
  };
}
