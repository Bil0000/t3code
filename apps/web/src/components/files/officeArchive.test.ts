import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { buildResidentRegionLayoutRequest } from "@betteroffice/docx/editor";
import { createYrsSession } from "@betteroffice/docx/yrs";
import { expect, it } from "vite-plus/test";

import { prepareOffice } from "./officeArchive";
import { expandedWordFixture } from "../../../test/officePreviewFixtures";

it.each(["footnotes", "footer"] as const)(
  "opens the prepared Word body after omitting expanded %s",
  async (role) => {
    const file = await expandedWordFixture(role);
    const prepared = await prepareOffice(await file.arrayBuffer(), "docx");
    expect(prepared.truncated).toBe(true);
    const session = await createYrsSession();
    try {
      const { document } = session.openDocx(new Uint8Array(prepared.bytes), true, {
        mediaTokens: true,
      });
      buildResidentRegionLayoutRequest(document, 0, {
        themeColors: {},
        defaultTabStopTwips: null,
        numericIds: {},
        mediaTokens: true,
      });
      expect(session.searchText("body retained")).toHaveLength(1);
      expect(session.searchText("omitted payload")).toHaveLength(0);
    } finally {
      session.destroy();
    }
  },
);

it.each([false, true])(
  "bounds shared strings including CDATA %s before the renderer",
  async (cdata) => {
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="one" sheetId="1" r:id="s"/><sheet name="two" sheetId="2" r:id="s"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    const sharedPath = cdata ? "customStrings.xml" : "sharedStrings.xml";
    archive.file(
      "xl/_rels/workbook.xml.rels",
      (await archive.file("xl/_rels/workbook.xml.rels")!.async("string")).replace(
        "</Relationships>",
        `<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${sharedPath}"/></Relationships>`,
      ),
    );
    const content = "x".repeat(32_767);
    archive.file(
      `xl/${sharedPath}`,
      `<sst><si><t>${cdata ? `<![CDATA[${content}]]>` : content}</t></si></sst>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData>${Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}">${Array.from({ length: 50 }, (_, j) => `<c r="${j < 26 ? String.fromCharCode(65 + j) : "A" + String.fromCharCode(65 + j - 26)}${i + 1}" t="s"><v>${cdata ? "<![CDATA[0]]>" : "0"}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`.replace(
        '<c r="A1" t="s"><v><![CDATA[0]]></v></c>',
        `<c r="A1" t="inlineStr"><is><t><![CDATA[${content}]]></t></is></c>`,
      ),
    );
    const prepared = await prepareOffice(
      await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }),
      "xlsx",
    );
    expect(prepared.truncated).toBe(true);
    const bounded = await JSZip.loadAsync(prepared.bytes);
    const cells: string[] = [];
    let inText = false;
    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", (tag) => {
      if (tag.local === "t") {
        inText = true;
        cells.push("");
      }
    });
    parser.on("text", (text) => {
      if (inText) cells[cells.length - 1] += text;
    });
    parser.on("closetag", (tag) => {
      if (tag.local === "t") inText = false;
    });
    parser.write(await bounded.file("xl/worksheets/sheet1.xml")!.async("string")).close();
    expect(cells.reduce((total, cell) => total + cell.length, 0)).toBe(1024 * 1024);
    expect(Math.max(...cells.map((cell) => cell.length))).toBe(4096);
  },
);
