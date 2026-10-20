"""
PPT/PDF/Word 文件解析服务 —— 按页解析

改进（相比旧版）：
- 按页返回，后面才能做「逐页对照讲解」。
- PPT：会读取组合图形（Group）里的文字、表格、演讲者备注，并保留页面里最大的一张图片。
- PDF：用 pypdfium2 把每一页渲染成图片（学生能看到原页面，模型也能看图），文字也更准。
- Word：按段落切成若干「部分」。
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field

import config

logger = logging.getLogger("aixue.parser")


@dataclass
class ParsedPage:
    page_no: int
    title: str = ""
    text: str = ""
    notes: str = ""
    image: bytes | None = None      # JPEG
    image_kind: str = ""            # page（整页截图）/ picture（页面里的图片）
    image_count: int = 0


@dataclass
class ParsedDoc:
    file_type: str
    pages: list[ParsedPage] = field(default_factory=list)

    @property
    def full_text(self) -> str:
        return "\n\n".join(f"--- 第{p.page_no}页 ---\n{p.text}" for p in self.pages if p.text.strip())


# ---------------------------------------------------------------- 图片工具

def _to_jpeg(img, max_width: int | None = None, quality: int = 72) -> bytes:
    from PIL import Image
    max_width = max_width or config.PAGE_IMAGE_WIDTH
    if img.mode not in ("RGB", "L"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            background.paste(img, mask=img.split()[-1])
        else:
            background.paste(img.convert("RGB"))
        img = background
    if img.width > max_width:
        h = int(img.height * max_width / img.width)
        img = img.resize((max_width, max(h, 1)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def _blob_to_jpeg(blob: bytes) -> bytes | None:
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(blob))
        img.load()
        if img.width < 80 or img.height < 80:  # 图标、小装饰，不要
            return None
        return _to_jpeg(img, max_width=900)
    except Exception:
        return None  # wmf/emf 等格式 Pillow 打不开，跳过


# ---------------------------------------------------------------- PPTX

def _iter_shapes(shapes):
    """递归展开组合图形"""
    for shape in shapes:
        yield shape
        if getattr(shape, "shape_type", None) is not None:
            from pptx.enum.shapes import MSO_SHAPE_TYPE
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from _iter_shapes(shape.shapes)


def parse_pptx(file_bytes: bytes) -> ParsedDoc:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    try:
        prs = Presentation(io.BytesIO(file_bytes))
    except Exception:
        raise ValueError(
            "无法解析该 PPT 文件。可能原因：\n"
            "1. 这是旧版 .ppt 格式（97-2003），请用 PowerPoint 另存为 .pptx 格式后重试\n"
            "2. 文件已损坏或不完整"
        )

    doc = ParsedDoc(file_type="pptx")
    for i, slide in enumerate(prs.slides, 1):
        if i > config.MAX_PAGES:
            break
        lines: list[str] = []
        title = ""
        best_pic: tuple[int, bytes] | None = None
        pic_count = 0
        try:
            if slide.shapes.title is not None and slide.shapes.title.has_text_frame:
                title = slide.shapes.title.text_frame.text.strip()
        except Exception:
            pass
        for shape in _iter_shapes(slide.shapes):
            try:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = "".join(run.text for run in para.runs).strip() or para.text.strip()
                        if t:
                            indent = "  " * (para.level or 0)
                            lines.append(f"{indent}{t}")
                if getattr(shape, "has_table", False) and shape.has_table:
                    for row in shape.table.rows:
                        cells = [c.text.strip() for c in row.cells if c.text.strip()]
                        if cells:
                            lines.append(" | ".join(cells))
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    pic_count += 1
                    size = int(shape.width or 0) * int(shape.height or 0)
                    if best_pic is None or size > best_pic[0]:
                        best_pic = (size, shape.image.blob)
            except Exception:
                continue  # 个别奇怪的图形跳过，不影响整页
        notes = ""
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
                notes = slide.notes_slide.notes_text_frame.text.strip()
        except Exception:
            pass
        image = _blob_to_jpeg(best_pic[1]) if best_pic else None
        doc.pages.append(ParsedPage(
            page_no=i, title=title or (lines[0][:120] if lines else ""), text="\n".join(lines),
            notes=notes, image=image, image_kind="picture" if image else "", image_count=pic_count,
        ))
    return doc


# ---------------------------------------------------------------- PDF

def parse_pdf(file_bytes: bytes) -> ParsedDoc:
    doc = ParsedDoc(file_type="pdf")
    try:
        import pypdfium2 as pdfium
    except ImportError:
        pdfium = None

    if pdfium is not None:
        try:
            pdf = pdfium.PdfDocument(file_bytes)
        except Exception:
            raise ValueError("无法解析该 PDF 文件，文件可能已损坏或加密")
        try:
            for i in range(min(len(pdf), config.MAX_PAGES)):
                page = pdf[i]
                try:
                    textpage = page.get_textpage()
                    text = (textpage.get_text_bounded() or "").replace("\r\n", "\n").replace("\r", "\n").strip()
                    textpage.close()
                except Exception:
                    text = ""
                image = None
                try:
                    width = page.get_width() or 1
                    scale = min(2.5, max(0.5, config.PAGE_IMAGE_WIDTH / width))
                    pil = page.render(scale=scale).to_pil()
                    image = _to_jpeg(pil)
                except Exception as e:
                    logger.warning("PDF page render failed: %s", e)
                lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
                doc.pages.append(ParsedPage(page_no=i + 1, title=lines[0][:120] if lines else "",
                                            text="\n".join(lines), image=image,
                                            image_kind="page" if image else ""))
                page.close()
        finally:
            pdf.close()
        return doc

    # 备用：没有 pypdfium2 时只取文字
    from PyPDF2 import PdfReader
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
    except Exception:
        raise ValueError("无法解析该 PDF 文件，文件可能已损坏或加密")
    for i, page in enumerate(reader.pages, 1):
        if i > config.MAX_PAGES:
            break
        text = (page.extract_text() or "").strip()
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        doc.pages.append(ParsedPage(page_no=i, title=lines[0][:120] if lines else "", text="\n".join(lines)))
    return doc


# ---------------------------------------------------------------- DOCX

def parse_docx(file_bytes: bytes, chunk_chars: int = 1200) -> ParsedDoc:
    from docx import Document

    try:
        d = Document(io.BytesIO(file_bytes))
    except Exception:
        raise ValueError("无法解析该 Word 文件。可能文件已损坏或使用了旧版 .doc 格式")

    blocks: list[tuple[bool, str]] = []  # (是否标题, 文本)
    for para in d.paragraphs:
        t = para.text.strip()
        if t:
            is_heading = (para.style is not None and str(para.style.name).lower().startswith(("heading", "title", "标题")))
            blocks.append((is_heading, t))
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                blocks.append((False, " | ".join(cells)))

    doc = ParsedDoc(file_type="docx")
    current: list[str] = []
    title = ""

    def flush():
        nonlocal current, title
        if current:
            doc.pages.append(ParsedPage(page_no=len(doc.pages) + 1, title=title or current[0][:120],
                                        text="\n".join(current)))
        current, title = [], ""

    for is_heading, t in blocks:
        size = sum(len(x) for x in current)
        if current and (is_heading or size + len(t) > chunk_chars):
            flush()
        if is_heading and not current:
            title = t[:120]
        current.append(t)
        if len(doc.pages) >= config.MAX_PAGES:
            break
    flush()
    return doc


# ---------------------------------------------------------------- 入口

def parse_document(filename: str, file_bytes: bytes) -> ParsedDoc:
    name = filename.lower()
    if name.endswith(".pptx"):
        return parse_pptx(file_bytes)
    if name.endswith(".ppt"):
        raise ValueError(
            "不支持旧版 .ppt 格式（97-2003 版本）。\n"
            "请用 PowerPoint 打开，点击「文件 → 另存为 → .pptx 格式」，然后重新上传。"
        )
    if name.endswith(".pdf"):
        return parse_pdf(file_bytes)
    if name.endswith(".docx"):
        return parse_docx(file_bytes)
    if name.endswith(".doc"):
        raise ValueError(
            "不支持旧版 .doc 格式（97-2003 版本）。\n"
            "请用 Word 打开，点击「文件 → 另存为 → .docx 格式」，然后重新上传。"
        )
    raise ValueError(f"不支持的文件格式: {filename}。仅支持 PPTX、PDF、DOCX 文件。")


def parse_file(filename: str, file_bytes: bytes) -> tuple[str, str]:
    """旧接口兼容：返回 (全文, 文件类型)"""
    doc = parse_document(filename, file_bytes)
    return doc.full_text, doc.file_type
