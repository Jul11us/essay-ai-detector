import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  canSubmit,
  formatElapsed,
  formatPercent,
  formatResult,
  isShortParagraph,
} from "./copy";
import type { DetectOk, Status } from "./types";

describe("canSubmit", () => {
  it("blocks when language missing", () => {
    expect(canSubmit(null, "hello world", null)).toBe(false);
  });
  it("blocks when no file and empty text", () => {
    expect(canSubmit("zh", "  ", null)).toBe(false);
  });
  it("allows file without textarea", () => {
    expect(canSubmit("en", "", new File(["x"], "a.txt"))).toBe(true);
  });
});

describe("formatPercent", () => {
  it("shows near-zero instead of 0.0", () => {
    expect(formatPercent(0)).toBe("<0.1");
    expect(formatPercent(0.0003)).toBe("<0.1");
  });
  it("keeps ordinary percentages to one decimal", () => {
    expect(formatPercent(0.008)).toBe("0.8");
    expect(formatPercent(0.6234)).toBe("62.3");
  });
});

describe("formatElapsed", () => {
  it("uses seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(59)).toBe("59 秒");
  });
  it("switches to minutes above that", () => {
    expect(formatElapsed(60)).toBe("1 分");
    expect(formatElapsed(95)).toBe("1 分 35 秒");
  });
});

describe("isShortParagraph", () => {
  it("treats heading-sized paragraphs as short", () => {
    expect(isShortParagraph({ char_count: 8 })).toBe(true);
    expect(isShortParagraph({ char_count: 79 })).toBe(true);
  });
  it("keeps real paragraphs out of the short bucket", () => {
    expect(isShortParagraph({ char_count: 80 })).toBe(false);
    expect(isShortParagraph({ char_count: 900 })).toBe(false);
  });
});

const SAMPLE: DetectOk = {
  score: 0.12,
  verdict: "low",
  confidence: "medium",
  mixed_variance: false,
  char_count: 800,
  word_count: 120,
  model_id: "demo",
  lang: "en",
  explanation: "",
  basis: "依据",
  reading: "阅读",
  review_risk: "likely_ok",
  review_label: "作业审查：按本站分数，暂未见明显高分段",
  review: "不是过关证明",
  disclaimer: "免责",
  paragraphs: [
    { index: 0, excerpt: "hello", score: 0.12, verdict: "low", char_count: 120 },
  ],
};

describe("formatResult", () => {
  it("explains the raw score without a school outcome forecast", () => {
    const text = formatResult(SAMPLE);
    expect(text).toContain("未经作文样本校准");
    expect(text).not.toContain("作业审查");
  });

  it("marks over-short paragraphs in the copied text too", () => {
    const text = formatResult({
      ...SAMPLE,
      paragraphs: [
        { index: 0, excerpt: "Abstract", score: 0.167, verdict: "low", char_count: 8 },
        { index: 1, excerpt: "正文", score: 0, verdict: "low", char_count: 900 },
      ],
    });
    expect(text).toContain("第1段 16.7% 较低（过短，仅供参考）：Abstract");
    expect(text).toContain("第2段 <0.1% 较低：正文");
  });
});

const READY: Status = {
  phase: "ready",
  detail: "中英文模型均已就绪",
  models: { zh: true, en: true },
  loading: false,
  heads: {
    zh: { kind: "softmax", ai_index: 1 },
    en: { kind: "sigmoid", ai_index: null },
  },
  label_check: { zh: { ai_style: 0.9994, human_style: 0.4591 } },
};

// 还在下载中文模型：英文已就绪，加载线程没结束。
const LOADING: Status = {
  ...READY,
  phase: "downloading",
  detail: "英文已就绪；正在准备中文模型…",
  models: { zh: false, en: true },
  loading: true,
  heads: { zh: { kind: null, ai_index: null }, en: { kind: "sigmoid", ai_index: null } },
  label_check: {},
};

const RESULT: DetectOk = { ...SAMPLE, score: 0.6234, verdict: "uncertain" };

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: Handler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function detectCalls(fn: ReturnType<typeof stubFetch>) {
  return fn.mock.calls.filter((call) => String(call[0]).includes("/api/detect"));
}

function statusCalls(fn: ReturnType<typeof stubFetch>) {
  return fn.mock.calls.filter((call) => String(call[0]).includes("/api/status"));
}

async function readyAppWithText() {
  await screen.findByText(/中英文模型均已就绪/);
  await userEvent.click(screen.getByRole("button", { name: /^英文\s*Vanguard$/ }));
  await userEvent.type(screen.getByLabelText(/粘贴正文/), "hello world");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 组件", () => {
  it("未选语言时按钮不可用，也不发检测请求", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(READY));
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);

    const go = screen.getByRole("button", { name: "开始检测" });
    expect(go).toBeDisabled();
    fireEvent.click(go);
    expect(detectCalls(fetchMock)).toHaveLength(0);
  });

  it("选了语言但没有正文和文件时，按钮仍不可用且不发请求", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(READY));
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);
    await userEvent.click(screen.getByRole("button", { name: /^英文\s*Vanguard$/ }));

    const go = screen.getByRole("button", { name: "开始检测" });
    expect(go).toBeDisabled();
    fireEvent.click(go);
    expect(detectCalls(fetchMock)).toHaveLength(0);
  });

  it("有正文且模型就绪时发出请求并显示结果", async () => {
    const fetchMock = stubFetch(async (url) =>
      url.includes("/api/status") ? jsonResponse(READY) : jsonResponse(RESULT),
    );
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    expect(await screen.findByText("62.3%")).toBeInTheDocument();
    expect(detectCalls(fetchMock)).toHaveLength(1);
  });

  it("演示文本可一键填入，但不声称真实来源标签", async () => {
    stubFetch(async () => jsonResponse(READY));
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);
    await userEvent.click(screen.getByRole("button", { name: "英文演示" }));
    expect((screen.getByLabelText(/粘贴正文/) as HTMLTextAreaElement).value).toContain("neighborhood library");
    expect(screen.getByText(/没有已知的人写或 AI 标签/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始检测" })).toBeEnabled();
  });

  it("上传文件先预览实际提取的正文，然后才允许检测", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      if (url.includes("/api/preview")) return jsonResponse({
        text: "The extracted essay has two paragraphs.",
        char_count: 39,
        paragraph_count: 2,
      });
      return jsonResponse(RESULT);
    });
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);
    await userEvent.click(screen.getByRole("button", { name: /^英文\s*Vanguard$/ }));
    await userEvent.upload(screen.getByLabelText(/上传 \.txt/), new File(["source"], "essay.txt", { type: "text/plain" }));
    expect(await screen.findByLabelText("文件提取文字预览")).toHaveValue("The extracted essay has two paragraphs.");
    expect(screen.getByRole("button", { name: "开始检测" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));
    expect(detectCalls(fetchMock)).toHaveLength(1);
  });

  it("预览失败时不发送检测请求", async () => {
    const fetchMock = stubFetch(async (url) =>
      url.includes("/api/status") ? jsonResponse(READY) : jsonResponse({ error: "parse_failed", message: "文件无法读取" }),
    );
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);
    await userEvent.click(screen.getByRole("button", { name: /^英文\s*Vanguard$/ }));
    await userEvent.upload(screen.getByLabelText(/上传 \.txt/), new File(["bad"], "essay.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("文件无法读取")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始检测" })).toBeDisabled();
    expect(detectCalls(fetchMock)).toHaveLength(0);
  });

  it("检测中显示已用时间和取消按钮，取消后能重来", async () => {
    stubFetch(async (url, init) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    expect(await screen.findByText(/已用/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消检测" }));

    expect(await screen.findByText("已取消检测。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始检测" })).toBeEnabled();
    expect(screen.queryByText(/已用/)).not.toBeInTheDocument();
  });

  it("检测中锁定输入，避免结果对应不上刚改的正文", async () => {
    stubFetch(async (url) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      return new Promise<Response>(() => {});
    });
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    await screen.findByText(/已用/);
    expect(screen.getByLabelText(/粘贴正文/)).toBeDisabled();
    expect(screen.getByRole("button", { name: /^英文\s*Vanguard$/ })).toBeDisabled();
  });

  it("过短的段折叠起来，不和正文段并排", async () => {
    stubFetch(async (url) =>
      url.includes("/api/status")
        ? jsonResponse(READY)
        : jsonResponse({
            ...RESULT,
            paragraphs: [
              { index: 0, excerpt: "Abstract", score: 0.167, verdict: "low", char_count: 8 },
              { index: 1, excerpt: "正文很长", score: 0, verdict: "low", char_count: 900 },
            ],
          }),
    );
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    expect(await screen.findByText(/另有 1 个过短的段/)).toBeInTheDocument();
    // 短段被收进 details，正文段仍在主列表里
    expect(screen.getByText("正文很长")).toBeInTheDocument();
  });

  it("整篇都是短段时不折叠，照常列出来", async () => {
    stubFetch(async (url) =>
      url.includes("/api/status")
        ? jsonResponse(READY)
        : jsonResponse({
            ...RESULT,
            paragraphs: [
              { index: 0, excerpt: "Abstract", score: 0.167, verdict: "low", char_count: 8 },
              { index: 1, excerpt: "Keywords", score: 0.2, verdict: "low", char_count: 12 },
            ],
          }),
    );
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    expect(await screen.findByText("Abstract")).toBeInTheDocument();
    expect(screen.queryByText(/过短的段/)).not.toBeInTheDocument();
  });

  it("加载结束后停止轮询 /api/status", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch(async () => jsonResponse(READY));
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(statusCalls(fetchMock)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(statusCalls(fetchMock)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("还在加载时继续轮询，加载一结束就停", async () => {
    vi.useFakeTimers();
    try {
      let pulls = 0;
      const fetchMock = stubFetch(async () => {
        pulls += 1;
        return jsonResponse(pulls < 3 ? LOADING : READY);
      });
      render(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(statusCalls(fetchMock)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(statusCalls(fetchMock)).toHaveLength(2);

      // 第三次拿到 loading: false，之后不该再有请求
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(statusCalls(fetchMock)).toHaveLength(3);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(statusCalls(fetchMock)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("单段重测只把这一段送回去，并更新总分", async () => {
    const first: DetectOk = {
      ...RESULT,
      score: 0.8,
      verdict: "high",
      paragraphs: [
        {
          index: 0,
          excerpt: "hello",
          text: `hello ${"word ".repeat(40)}`,
          score: 0.8,
          verdict: "high",
          char_count: 200,
        },
      ],
    };
    const second: DetectOk = {
      ...first,
      score: 0.18,
      verdict: "low",
      paragraphs: [
        {
          index: 0,
          excerpt: "rewritten",
          text: `rewritten ${"word ".repeat(40)}`,
          score: 0.18,
          verdict: "low",
          char_count: 220,
        },
      ],
    };
    let detects = 0;
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      if (url.includes("/api/explain")) {
        return jsonResponse({
          markers: [{ phrase: "delve", count: 1 }],
          rhythm: {
            lengths: [12, 40],
            mean: 26,
            cv: 0.6,
            label: "起伏明显",
            note: "长短交替",
            truncated: false,
          },
        });
      }
      if (url.includes("/api/sentences")) {
        return jsonResponse({
          sentences: [
            { text: "AI wrote this sentence today.", score: 0.9, verdict: "high", highlight: "high" },
          ],
          capped: false,
          note: "",
        });
      }
      detects += 1;
      return jsonResponse(detects === 1 ? first : second);
    });
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));
    expect((await screen.findAllByText("80.0%")).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "在此修改并重测本段" }));
    await userEvent.click(screen.getByRole("button", { name: "重测这一段" }));
    expect((await screen.findAllByText("18.0%")).length).toBeGreaterThan(0);

    const bodies = detectCalls(fetchMock).map((call) =>
      JSON.parse(String(call[1]?.body)),
    );
    expect(bodies[1].scope).toBe("paragraph");
    expect(bodies[1].text).toContain("word");
    expect(bodies[1].text).not.toBe(bodies[0].text);
    expect(await screen.findByText("delve")).toBeInTheDocument();
  });

  it("中英分开把两栏分别提交", async () => {
    const fetchMock = stubFetch(async (url) =>
      url.includes("/api/status")
        ? jsonResponse(READY)
        : jsonResponse({
            lang: "bi",
            note: "不会混成一个总分",
            disclaimer: "免责",
            en: RESULT,
            zh: null,
          }),
    );
    render(<App />);
    await screen.findByText(/中英文模型均已就绪/);
    await userEvent.click(screen.getByRole("button", { name: /中英分开/ }));
    await userEvent.type(screen.getByLabelText(/英文摘要/), "An abstract about rivers.");
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));
    expect(await screen.findByText(/不会混成一个总分/)).toBeInTheDocument();
    const body = JSON.parse(String(detectCalls(fetchMock)[0][1]?.body));
    expect(body.lang).toBe("bi");
    expect(body.en).toContain("rivers");
  });

  it("嫌疑最重的句子涂红，并列在段落上方", async () => {
    const scored: DetectOk = {
      ...RESULT,
      score: 0.85,
      verdict: "high",
      paragraphs: [
        {
          index: 0,
          excerpt: "p",
          text: `First line. Second line. ${"word ".repeat(30)}`,
          score: 0.85,
          verdict: "high",
          char_count: 200,
        },
      ],
    };
    stubFetch(async (url) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      if (url.includes("/api/sentences")) {
        return jsonResponse({
          sentences: [
            { text: "Mild sentence here.", score: 0.65, verdict: "uncertain", highlight: "mid" },
            { text: "Most suspicious sentence.", score: 0.96, verdict: "high", highlight: "high", observations: [{ phrase: "template phrase", count: 1 }] },
          ],
          capped: false,
          note: "",
        });
      }
      return jsonResponse(scored);
    });
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));

    expect(await screen.findByText("优先复核的句子")).toBeInTheDocument();
    // 段分数 0.85 时先是「大部分像 AI」；逐句结果回来后按句子重算：
    // 像 AI 的一句 23 字、不确定的一句 17 字 → 约 57% 像 AI → 混合。
    expect(await screen.findByText("高低分并存")).toBeInTheDocument();
    expect(screen.getByText(/约 57% 为较高分/)).toBeInTheDocument();
    const inBody = screen
      .getAllByText("Most suspicious sentence.")
      .find((el) => el.classList.contains("sent"));
    expect(inBody).toHaveClass("sent", "top");
    expect(screen.getByText("Mild sentence here.")).toHaveClass("sent", "mid");
    const finding = screen.getByRole("button", { name: /96\.0%.*Most suspicious sentence\./ });
    await userEvent.click(finding);
    expect(screen.getByText(/可观察的套话：template phrase/)).toBeInTheDocument();
    expect(screen.getByText(/不是分数的因果解释/)).toBeInTheDocument();
  });

  it("整篇每一段都逐句打分，分数高的段先跑", async () => {
    const para = (index: number, score: number, word: string) => ({
      index,
      excerpt: word,
      text: `${word} ${"filler ".repeat(20)}`,
      score,
      verdict: (score >= 0.75 ? "high" : "low") as DetectOk["paragraphs"][number]["verdict"],
      char_count: 150,
    });
    const doc: DetectOk = {
      ...RESULT,
      paragraphs: [para(0, 0.1, "alpha"), para(1, 0.95, "bravo"), para(2, 0.4, "charlie")],
    };
    const scanned: string[] = [];
    stubFetch(async (url, init) => {
      if (url.includes("/api/status")) return jsonResponse(READY);
      if (url.includes("/api/sentences")) {
        const text = JSON.parse(String(init?.body)).text as string;
        scanned.push(text.split(" ")[0]);
        return jsonResponse({
          sentences: [{ text: `${text.split(" ")[0]} scored sentence.`, score: 0.3, verdict: "low", highlight: null }],
          capped: false,
          note: "",
        });
      }
      return jsonResponse(doc);
    });
    render(<App />);
    await readyAppWithText();
    await userEvent.click(screen.getByRole("button", { name: "开始检测" }));
    expect(await screen.findByText("charlie scored sentence.")).toBeInTheDocument();
    expect(await screen.findByText("alpha scored sentence.")).toBeInTheDocument();
    expect(scanned).toEqual(["bravo", "charlie", "alpha"]);
    expect(screen.getByText("alpha scored sentence.")).toHaveAttribute("title", "查看本句模型分数：30.0%");
    expect(screen.queryByText(/正在逐句打分/)).not.toBeInTheDocument();
  });

  it("连不上后端时保持重试", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = stubFetch(async () => {
        throw new Error("offline");
      });
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(statusCalls(fetchMock)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(statusCalls(fetchMock).length).toBeGreaterThan(1);
      expect(screen.getByText(/无法连接检测服务/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
