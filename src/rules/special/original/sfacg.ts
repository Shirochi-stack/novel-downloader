import * as CryptoJS from "crypto-js";
import {
  getAttachment,
  putAttachmentClassCache,
} from "../../../lib/attachments";
import { cleanDOM } from "../../../lib/cleanDOM";
import { getHtmlDOM, gfetch } from "../../../lib/http";
import { rm } from "../../../lib/dom";
import { getSectionName, introDomHandle } from "../../../lib/rule";
import { log } from "../../../log";
import { Status } from "../../../main/main";
import { AttachmentClass } from "../../../main/Attachment";
import { Chapter } from "../../../main/Chapter";
import { Book, BookAdditionalMetadate } from "../../../main/Book";
import { BaseRuleClass, ChapterParseObject } from "../../../rules";
import { retryLimit } from "../../../setting";

const SFACG_API_DEVICE_TOKEN = "910D166A-736E-3231-8B21-8D12DFD75F16";
const SFACG_API_SALT = "lPQDb9AKO7$LjkPG";
const SFACG_API_AUTHORIZATION =
  "Basic YW5kcm9pZHVzZXI6MWEjJDUxLXl0Njk7KkFjdkBxeHE=";
const SFACG_API_SIGN_RETRY_LIMIT = Math.max(retryLimit, 20);
const SFACG_API_NONCE_TEST_URL =
  "https://api.sfacg.com/Chaps/8436696?expand=content%2Cexpand.content";
let sfacgApiNonce: string | null = null;
let sfacgApiNoncePromise: Promise<string | null> | null = null;

interface SfacgApiChapterResponse {
  status?: {
    httpCode?: number;
  };
  data?: {
    title?: string;
    content?: string;
    expand?: {
      content?: string;
    };
  };
}

function createSfacgNonce() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().toUpperCase();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    })
    .toUpperCase();
}

function getSfacgApiSign(nonce: string, timestamp: number) {
  const longNonce = nonce.repeat(4);
  const indexCalc = (index: number) => {
    const charCode = longNonce.charCodeAt(index);
    return charCode - Math.floor(charCode / 0x24) * 0x24;
  };
  const nonceReorder =
    longNonce.slice(indexCalc(1), indexCalc(1) + 13) +
    longNonce.slice(indexCalc(2), indexCalc(2) + 16) +
    longNonce.slice(indexCalc(3), indexCalc(3) + 36) +
    longNonce.slice(indexCalc(4), indexCalc(4) + 36);

  const authString =
    String(timestamp) + SFACG_API_SALT + SFACG_API_DEVICE_TOKEN + nonce;
  let result = "";
  for (let i = 0; i < authString.length; i++) {
    result += String.fromCharCode(
      (authString.charCodeAt(i) + nonceReorder.charCodeAt(i)) >> 1,
    );
  }

  const parts = [
    result.slice(0, 13),
    result.slice(13, 29),
    result.slice(29, 65),
    result.slice(65),
  ];
  const stringAfterReorder = parts[3] + parts[0] + parts[2] + parts[1];

  let final = "";
  for (const char of stringAfterReorder) {
    const charCode = char.charCodeAt(0);
    if (charCode < 0x30) {
      final +=
        0x39 < charCode + 19 && charCode + 19 < 0x41
          ? String.fromCharCode(0x39)
          : String.fromCharCode(charCode + 19);
    } else if (
      (0x39 < charCode && charCode < 0x41) ||
      (0x5a < charCode && charCode < 0x61)
    ) {
      final += String.fromCharCode(charCode + 19);
    } else {
      final += char;
    }
  }

  return CryptoJS.MD5(final).toString(CryptoJS.enc.Hex).toUpperCase();
}

function getSfacgApiContent(data: SfacgApiChapterResponse["data"]) {
  if (!data) {
    return "";
  }
  return [data.content, data.expand?.content]
    .filter((content): content is string => typeof content === "string")
    .join("");
}

function getSfacgApiHeaders(nonce: string) {
  const timestamp = Date.now();
  const sign = getSfacgApiSign(nonce, timestamp);
  const sfsecurity = `nonce=${nonce}&timestamp=${timestamp}&devicetoken=${SFACG_API_DEVICE_TOKEN}&sign=${sign}`;
  return {
    accept: "application/vnd.sfacg.api+json;version=1",
    "accept-charset": "UTF-8",
    "accept-encoding": "gzip",
    authorization: SFACG_API_AUTHORIZATION,
    "content-type": "application/json; charset=UTF-8",
    sfsecurity,
    "user-agent": `boluobao/5.2.16(android;35)/OPPO/${SFACG_API_DEVICE_TOKEN.toLowerCase()}/OPPO`,
  };
}

async function requestSfacgApi(url: string, nonce: string) {
  const response = await gfetch(url, {
    method: "GET",
    headers: getSfacgApiHeaders(nonce),
  });
  return JSON.parse(response.responseText) as SfacgApiChapterResponse;
}

async function initSfacgApiNonce() {
  if (sfacgApiNonce) {
    return sfacgApiNonce;
  }
  if (sfacgApiNoncePromise) {
    return sfacgApiNoncePromise;
  }
  sfacgApiNoncePromise = (async () => {
    for (let retry = 0; retry < SFACG_API_SIGN_RETRY_LIMIT; retry++) {
      const nonce = createSfacgNonce();
      try {
        const data = await requestSfacgApi(SFACG_API_NONCE_TEST_URL, nonce);
        if (data.status?.httpCode !== 417) {
          sfacgApiNonce = nonce;
          log.info(`[sfacg] initialized app API nonce`);
          return nonce;
        }
      } catch (error) {
        log.warn(`[sfacg] API nonce probe failed`, error);
      }
      if (
        retry === 0 ||
        retry % 5 === 4 ||
        retry === SFACG_API_SIGN_RETRY_LIMIT - 1
      ) {
        log.warn(
          `[sfacg] API nonce rejected, retry ${retry + 1}/${SFACG_API_SIGN_RETRY_LIMIT}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  })().finally(() => {
    sfacgApiNoncePromise = null;
  });
  return sfacgApiNoncePromise;
}

async function getSfacgApiChapter(chapterId: string) {
  const url = `https://api.sfacg.com/Chaps/${chapterId}?expand=content%2Cexpand.content`;
  for (let retry = 0; retry < SFACG_API_SIGN_RETRY_LIMIT; retry++) {
    const nonce = await initSfacgApiNonce();
    if (!nonce) {
      return null;
    }
    const data = await requestSfacgApi(url, nonce);
    const httpCode = data.status?.httpCode;
    if (httpCode === 200 && data.data) {
      sfacgApiNonce = nonce;
      return data.data;
    }
    if (httpCode === 417) {
      sfacgApiNonce = null;
      if (
        retry === 0 ||
        retry % 5 === 4 ||
        retry === SFACG_API_SIGN_RETRY_LIMIT - 1
      ) {
        log.warn(
          `[sfacg] API signature rejected (not a purchase check), rotating nonce ${retry + 1}/${SFACG_API_SIGN_RETRY_LIMIT}`,
        );
      }
      continue;
    }
    if (httpCode === 401 || httpCode === 403) {
      log.warn(
        `[sfacg] API chapter ${chapterId} requires an app session with access (${httpCode})`,
      );
      return null;
    }
    log.warn(`[sfacg] API chapter ${chapterId} returned ${httpCode}`);
    return null;
  }
  return null;
}

function buildTextChapter(
  chapterName: string | null,
  contentText: string,
): ChapterParseObject {
  const contentHTML = document.createElement("div");
  for (const line of contentText.split(/\r?\n/)) {
    const p = document.createElement("p");
    p.textContent = line;
    contentHTML.appendChild(p);
  }
  return {
    chapterName,
    contentRaw: contentHTML,
    contentText,
    contentHTML,
    contentImages: null,
    additionalMetadate: null,
  };
}

function removeInvalidSfacgImages(content: HTMLElement) {
  for (const img of Array.from(content.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const dataSrc = img.getAttribute("data-src") ?? "";
    const resolvedSrc = (img as HTMLImageElement).src ?? "";
    const source = `${src} ${dataSrc} ${resolvedSrc}`.toLowerCase();
    if (
      source.includes("file:/") ||
      /(^|\s|images)[a-z]:[\\/]/.test(source) ||
      source.includes("\\\\")
    ) {
      log.warn(`[sfacg] skipping invalid local image reference: ${src}`);
      img.remove();
    }
  }
  return content;
}

export class Sfacg extends BaseRuleClass {
  public constructor() {
    super();
    this.attachmentMode = "TM";
    this.concurrencyLimit = 1;
  }

  public async bookParse() {
    const bookUrl = document.location.href.replace("/MainIndex/", "");
    const bookname = (
      document.querySelector("h1.story-title") as HTMLElement
    ).innerText.trim();

    const dom = await getHtmlDOM(bookUrl, undefined);
    const author = (
      dom.querySelector(".author-name") as HTMLElement
    ).innerText.trim();
    const introDom = dom.querySelector(".introduce");
    const [introduction, introductionHTML] = await introDomHandle(introDom);

    const additionalMetadate: BookAdditionalMetadate = {};
    const coverUrl = (
      dom.querySelector("#hasTicket div.pic img") as HTMLImageElement
    ).src;
    if (coverUrl) {
      getAttachment(coverUrl, this.attachmentMode, "cover-")
        .then((coverClass) => {
          additionalMetadate.cover = coverClass;
        })
        .catch((error) => log.error(error));
    }
    additionalMetadate.tags = Array.from(
      dom.querySelectorAll("ul.tag-list > li.tag > a"),
    ).map((a) => {
      rm("span.icn", false, a as HTMLAnchorElement);
      return (a as HTMLAnchorElement).innerText.trim().replace(/\(\d+\)$/, "");
    });
    if (dom.querySelector(".d-banner")) {
      const _beitouUrl = (
        dom.querySelector(".d-banner") as HTMLDivElement
      )?.style.backgroundImage.split('"');
      if (_beitouUrl?.length === 3) {
        const beitouUrl = _beitouUrl[1];
        const beitou = new AttachmentClass(
          beitouUrl,
          `beitou.${beitouUrl.split(".").slice(-1)[0]}`,
          "TM",
        );
        beitou.init();
        additionalMetadate.attachments = [beitou];
      }
    }

    const chapters: Chapter[] = [];
    const sections = document.querySelectorAll(".story-catalog");
    const chapterElems = document.querySelectorAll(".catalog-list a");
    const getName = (sElem: Element) =>
      (sElem.querySelector(".catalog-title") as HTMLElement).innerText
        .replace(`【${bookname}】`, "")
        .trim();

    let chapterNumber = 0;
    let sectionNumber = 0;
    let sectionChapterNumber = 0;
    let _sectionName = "";
    for (const elem of Array.from(chapterElems)) {
      const chapterName =
        (elem as HTMLAnchorElement).getAttribute("title")?.trim() ?? "";
      const chapterUrl = (elem as HTMLAnchorElement).href;
      const sectionName = getSectionName(elem, sections, getName);
      if (sectionName && _sectionName !== sectionName) {
        _sectionName = sectionName;
        sectionNumber++;
        sectionChapterNumber = 0;
      }
      chapterNumber++;
      sectionChapterNumber++;

      const isVip = () => {
        return (
          elem.childElementCount !== 0 &&
          elem.firstElementChild?.getAttribute("class") === "icn_vip"
        );
      };
      // 无法从章节列表判断章节支付情况
      const isPaid = null;
      const chapter = new Chapter({
        bookUrl,
        bookname,
        chapterUrl,
        chapterNumber,
        chapterName,
        isVIP: isVip(),
        isPaid,
        sectionName,
        sectionNumber,
        sectionChapterNumber,
        chapterParse: this.chapterParse,
        charset: this.charset,
        options: {},
      });
      const isLogin = !document
        .querySelector(".user-bar > .top-link > .normal-link")
        ?.innerHTML.includes("您好，SF游客");
      if (chapter.isVIP && !isLogin) {
        chapter.status = Status.aborted;
      }
      chapters.push(chapter);
    }

    const book = new Book({
      bookUrl,
      bookname,
      author,
      introduction,
      introductionHTML,
      additionalMetadate,
      chapters,
    });
    book.ToCUrl = document.location.href;
    return book;
  }

  public async chapterParse(
    chapterUrl: string,
    chapterName: string | null,
    isVIP: boolean,
    isPaid: boolean,
    charset: string,
    options: object,
  ) {
    const chapterId = chapterUrl.split("/").slice(-2, -1)[0];

    async function publicChapter(): Promise<ChapterParseObject> {
      const doc = await getHtmlDOM(chapterUrl, charset);
      chapterName = (
        doc.querySelector("h1.article-title") as HTMLElement
      ).innerText.trim();
      const content = doc.querySelector(".article-content") as HTMLElement;
      if (content) {
        removeInvalidSfacgImages(content);
        const { dom, text, images } = await cleanDOM(content, "TM");
        return {
          chapterName,
          contentRaw: content,
          contentText: text,
          contentHTML: dom,
          contentImages: images,
          additionalMetadate: null,
        };
      } else {
        return {
          chapterName,
          contentRaw: null,
          contentText: null,
          contentHTML: null,
          contentImages: null,
          additionalMetadate: null,
        };
      }
    }

    async function vipChapter(): Promise<ChapterParseObject> {
      async function apiTextChapter(): Promise<ChapterParseObject | null> {
        try {
          const data = await getSfacgApiChapter(chapterId);
          const contentText = getSfacgApiContent(data);
          if (!contentText.trim()) {
            return null;
          }
          return buildTextChapter(data?.title ?? chapterName, contentText);
        } catch (error) {
          log.warn(`[sfacg] API text chapter failed: ${chapterUrl}`, error);
          return null;
        }
      }

      async function getvipChapterImage(
        vipChapterImageUrl: string,
        vipChapterName: string,
      ) {
        let retryTime = 0;

        function fetchVipChapterImage(
          vipChapterImageUrlI: string,
        ): Promise<Blob | null | void> {
          log.debug(
            `[Chapter]请求 ${vipChapterImageUrlI} Referer ${chapterUrl} 重试次数 ${retryTime}`,
          );

          return fetch(vipChapterImageUrlI, {
            headers: {
              accept:
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
            referrer: chapterUrl,
            body: null,
            method: "GET",
            mode: "cors",
            credentials: "include",
          })
            .then((response) => response.blob())
            .then((blob) => {
              if (blob.size === 53658 || blob.size === 42356) {
                log.error(
                  `[Chapter]请求 ${vipChapterImageUrlI} 失败 Referer ${chapterUrl}`,
                );
                if (retryTime < retryLimit) {
                  retryTime++;
                  return fetchVipChapterImage(vipChapterImageUrlI);
                } else {
                  return null;
                }
              } else {
                return blob;
              }
            })
            .catch((error) => log.error(error));
        }

        const vipChapterImageBlob =
          await fetchVipChapterImage(vipChapterImageUrl);
        const vipChapterImage = new AttachmentClass(
          vipChapterImageUrl,
          vipChapterName,
          "naive",
        );
        if (vipChapterImageBlob) {
          vipChapterImage.Blob = vipChapterImageBlob;
          vipChapterImage.status = Status.finished;
        } else {
          vipChapterImage.status = Status.failed;
        }
        return vipChapterImage;
      }

      const apiChapter = await apiTextChapter();
      if (apiChapter) {
        return apiChapter;
      }

      const isLogin =
        document.querySelector(".user-bar > .top-link > .normal-link")
          ?.childElementCount === 3;
      if (isLogin) {
        const dom = await getHtmlDOM(chapterUrl, charset);
        const chapterNameI = (
          dom.querySelector("h1.article-title") as HTMLElement
        ).innerText.trim();

        isPaid = dom.querySelector(".pay-section") === null;
        if (isPaid) {
          const vipChapterDom = dom.querySelector(
            ".article-content > #vipImage",
          ) as HTMLImageElement;
          if (vipChapterDom) {
            const vipChapterImageUrl = vipChapterDom.src;
            const vipChapterName = `vipCHapter${chapterId}.gif`;
            const vipChapterImage = await getvipChapterImage(
              vipChapterImageUrl,
              vipChapterName,
            );
            putAttachmentClassCache(vipChapterImage);
            const contentImages = [vipChapterImage];
            const img = document.createElement("img");
            img.setAttribute("data-src-address", vipChapterName);
            img.alt = vipChapterImageUrl;
            const contentHTML = document.createElement("div");
            contentHTML.appendChild(img);

            const contentText = `VIP章节，请打开HTML文件查看。\n![${vipChapterImageUrl}](${vipChapterName})`;

            return {
              chapterName: chapterNameI,
              contentRaw: contentHTML,
              contentText,
              contentHTML,
              contentImages,
              additionalMetadate: null,
            };
          } else {
            return publicChapter();
          }
        }
      }
      return {
        chapterName,
        contentRaw: null,
        contentText: null,
        contentHTML: null,
        contentImages: null,
        additionalMetadate: null,
      };
    }

    if (isVIP) {
      return vipChapter();
    } else {
      return publicChapter();
    }
  }
}
