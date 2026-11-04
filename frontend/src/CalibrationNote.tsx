import type { CalibrationInfo } from "./types";

export function CalibrationNote({ info }: { info?: CalibrationInfo }) {
  return (
    <div>
      <p>
        <strong>整篇阈值：{info?.applied ? "已在样本范围内验证" : "沿用默认门槛"}</strong>
      </p>
      <p>{info?.note || "尚未启用独立测试通过的整篇阈值。段落和句子着色尚未校准。"}</p>
      {info?.counts?.test && (
        <p>
          独立测试样本：人写 {info.counts.test.human} 篇，AI {info.counts.test.ai} 篇，混合{" "}
          {info.counts.test.mixed} 篇。
        </p>
      )}
      {info?.applicability?.source_domains?.length ? (
        <p>评测来源范围：{info.applicability.source_domains.join("、")}。</p>
      ) : null}
      {info?.applicability?.char_count && (
        <p>
          评测长度范围：{info.applicability.char_count.min}–{info.applicability.char_count.max}{" "}
          个非空白字符。
        </p>
      )}
      {info?.applied && (
        <p>
          整篇较低门槛 {(info.low * 100).toFixed(1)}%，较高门槛 {(info.high * 100).toFixed(1)}
          %。这只调整档位，不把分数转换为作者身份概率。
        </p>
      )}
    </div>
  );
}
