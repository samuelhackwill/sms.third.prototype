#!/usr/bin/env python3

import argparse
import html
import json
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET


OPF_NS = {"opf": "http://www.idpf.org/2007/opf"}
XHTML_NS = {"xhtml": "http://www.w3.org/1999/xhtml"}
TAG_RE = re.compile(r"\s+")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…»])\s+(?=[«\"“”A-ZÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ0-9])")


def normalize_text(text):
    text = text.replace("\xa0", " ")
    text = TAG_RE.sub(" ", text)
    return text.strip()


def sentence_split(text):
    parts = []
    for chunk in SENTENCE_SPLIT_RE.split(text):
        chunk = normalize_text(chunk)
        if chunk:
          parts.append(chunk)
    return parts


def text_with_breaks(node):
    pieces = []

    def walk(element):
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "a" and element.get("id", "").startswith(("page_", "indx-")):
            pass
        elif tag in {"script", "style"}:
            return
        else:
            if element.text:
                pieces.append(element.text)
            for child in element:
                walk(child)
                if child.tail:
                    pieces.append(child.tail)
            if tag in {"p", "div", "h1", "h2", "h3", "li", "blockquote"}:
                pieces.append("\n")

    walk(node)
    return "".join(pieces)


class BodyTextParser(HTMLParser):
    BLOCK_TAGS = {"p", "div", "h1", "h2", "h3", "li", "blockquote", "br"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_body = False
        self.chunks = []
        self.title_chunks = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "body":
            self.in_body = True
        if not self.in_body:
            return
        if tag == "h1":
            self.in_title = True
        if tag == "a" and attrs_dict.get("id", "").startswith(("page_", "indx-")):
            return
        if tag in self.BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag == "body":
            self.in_body = False
        if not self.in_body and tag != "body":
            return
        if tag == "h1":
            self.in_title = False
        if tag in self.BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_data(self, data):
        if not self.in_body:
            return
        self.chunks.append(data)
        if self.in_title:
            self.title_chunks.append(data)

    def get_body_text(self):
        return normalize_text("".join(self.chunks))

    def get_title(self):
        title = normalize_text("".join(self.title_chunks))
        return title or None


def get_opf_path(epub_zip):
    container_xml = ET.fromstring(epub_zip.read("META-INF/container.xml"))
    rootfile = container_xml.find(".//{*}rootfile")
    if rootfile is None:
        raise RuntimeError("EPUB container.xml missing rootfile")
    return rootfile.attrib["full-path"]


def ordered_text_items(epub_zip, opf_path):
    opf_dir = str(Path(opf_path).parent)
    package = ET.fromstring(epub_zip.read(opf_path))

    manifest = {}
    for item in package.findall(".//opf:manifest/opf:item", OPF_NS):
        if item.attrib.get("media-type") == "application/xhtml+xml":
            href = item.attrib["href"]
            manifest[item.attrib["id"]] = str((Path(opf_dir) / href).as_posix())

    itemrefs = package.findall(".//opf:spine/opf:itemref", OPF_NS)
    ordered = [manifest[itemref.attrib["idref"]] for itemref in itemrefs if itemref.attrib["idref"] in manifest]
    return ordered


def extract_sentences(epub_path):
    with zipfile.ZipFile(epub_path) as epub_zip:
        opf_path = get_opf_path(epub_zip)
        items = ordered_text_items(epub_zip, opf_path)

        sentence_index = 0
        for item_path in items:
            if item_path.endswith(("cover.xhtml", "sommaire.html", "toc.ncx")):
                continue

            raw_html = epub_zip.read(item_path).decode("utf-8", errors="ignore")
            raw_html = raw_html.replace("&nbsp;", " ")
            parser = BodyTextParser()
            parser.feed(raw_html)
            parser.close()

            chapter_title = parser.get_title()
            full_text = parser.get_body_text()
            if not full_text or not chapter_title:
                continue

            for sentence in sentence_split(full_text):
                sentence_index += 1
                yield {
                    "index": sentence_index,
                    "chapter": chapter_title,
                    "source_file": item_path,
                    "text": sentence,
                }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with args.output.open("w", encoding="utf-8") as handle:
        for record in extract_sentences(args.input):
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1

    print(f"wrote {count} sentences to {args.output}")


if __name__ == "__main__":
    main()
