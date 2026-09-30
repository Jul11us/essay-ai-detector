DISCLAIMER = "本结果仅表示开源模型的写作倾向，不能作为学术不端认定依据。"

MESSAGES = {
    "lang_required": "请先选择中文、英文，或中英分开。",
    "bad_request": "请求格式不对。请刷新页面后重试。",
    "payload_too_large": "提交的内容太大（上限 20 MB）。请只提交正文文本。",
    "empty": "没有读到正文。",
    "too_short": "文本太短，无法给出可靠结果（中文至少约 150 字，英文至少约 200 个字符）。",
    "too_long": "文本超出第一版上限（中文约 10000 字，英文约 8000 词），请拆成多篇再测。",
    "language_mismatch": "正文语言和所选语言明显不符。请改选后重试；本站不会在选错时给出分数。",
    "parse_failed": "无法读取文件。请使用 UTF-8 或 GBK 的 .txt、未损坏的 .docx，或可选中文字的 PDF。",
    "archive_too_large": "这份 .docx 解压后太大（上限 100 MB），可能不是正常的作业文件。请另存为 .txt，或只保留正文再上传。",
    "too_many_pages": "这份 PDF 页数太多（上限 300 页）。请只上传要检测的部分，或另存为 .txt。",
    "scanned_pdf": "这份 PDF 几乎没有可复制的文字，多半是扫描件。请换成文字版 PDF，或先另存为 .txt / .docx。",
    "section_too_short": "这一部分太短，没有单独打分。",
    "models_not_ready": "模型还在准备，请稍后再试。",
    "infer_failed": "本机推理失败，未生成分数。",
    "cancelled": "已取消检测。",
}

HTTP_STATUS = {
    "lang_required": 400,
    "bad_request": 400,
    "payload_too_large": 400,
    "empty": 400,
    "too_short": 400,
    "too_long": 400,
    "language_mismatch": 400,
    "parse_failed": 400,
    "archive_too_large": 400,
    "too_many_pages": 400,
    "scanned_pdf": 400,
    "section_too_short": 400,
    "models_not_ready": 503,
    "infer_failed": 500,
    # 客户端已经断开，这个状态码基本没人读到；用 409 表示「请求被放弃」。
    "cancelled": 409,
}


class DetectError(Exception):
    def __init__(self, code: str) -> None:
        if code not in MESSAGES:
            raise ValueError(f"unknown detect error: {code}")
        self.code = code
        self.http_status = HTTP_STATUS[code]
        self.message = MESSAGES[code]
        super().__init__(self.message)
