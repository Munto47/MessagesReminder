/**
 * 与 uni-app 前端一致的响应解密（来源：index.c4d86917.js）
 *
 * 对称：CryptoJS AES-256-ECB + PKCS7（无 IV）
 * 非对称：RSA（JSEncrypt），PKCS#1 v1.5，与 Node crypto.privateDecrypt RSA_PKCS1_PADDING 对齐
 *
 * 流程：encrypt-flag 经私钥解密得到 Base64 字符串 → 再 Base64 解出 32 字节 AES 密钥 → AES 解密响应体 → JSON.parse
 */

import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

/** 与前端 e58e 模块中 setPrivateKey / setPublicKey 一致（RSA，非 SM2） */
export const RSA_PUBLIC_KEY_BASE64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDv8FbenO7doAo4pfO4kr9eamUpvzA2xs8DNPFPEdp3VkWO7uOdfK1xXJ9Qp95spRKcKrqEQbeyUEDU9OxoZBej3IfurcXRxCTWMjXKbMbQaE5Em7B6tergx+1fItD21GfsnlqlBmWaDROXcavsQ0EcXhELf0ZLu6sKQ+LNZYPd9QIDAQAB";

export const RSA_PRIVATE_KEY_BASE64 =
  "MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAO/wVt6c7t2gCjil87iSv15qZSm/MDbGzwM08U8R2ndWRY7u4518rXFcn1Cn3mylEpwquoRBt7JQQNT07GhkF6Pch+6txdHEJNYyNcpsxtBoTkSbsHq16uDH7V8i0PbUZ+yeWqUGZZoNE5dxq+xDQRxeEQt/Rku7qwpD4s1lg931AgMBAAECgYADfTI2MIAEtwQPCNK/d1rTC6cG8WHJGiD+gfGUXcUYgSenyW+D5cE76cXjTV2dpNTdcn2d2LrMHAClWB5r8jCpySAymroQ3xNu1sxdt4YG0FhuwxByrvUeNmN+2H+Rw5bZnnmnTSeHtVLYv7VKXpehlZlymeSayJ0R25JHIii0gQJBAPDvjLG7LrEoDxQU3qpWNu8jImN1nPpMnPBB2Se0Fd17EgvnQ5H1k8w3JG39pcQMJRZcqae7qQFG56801u6Jy9UCQQD+8NU+v8xnhcyyWs49igc9vG5gMuAKpb2pi352CB/HwDS+KdZbxPJqFJKQKUjyLapkK5kWWDiP/Ns5CrfB93mhAkBzGT0ROuaXYxew9DdbEEy1+QbYlLslJ6xhalOfD/zSDZUVcqlo9PRiPoV8tguWmGavRB0YMCIQphrQLGHxGorxAkA+Dr/J64RFOuOuEr6baksC8yhnEFtLHDdD2ynob2fVBuuP0r1UT2e2/NUEdJhGI2mTwq0cLFNwcVun0f0TITuhAkEAmxL5C7xumUgZpg7YeAVrcDs4N/GdhnCDKyZgcV0M/BRpzVO5gx+573z3NHuBzvdrhLSBEY+6voy3/K3g6lt2vA==";

function toPkcs1PrivatePem(base64Body) {
  return `-----BEGIN RSA PRIVATE KEY-----\n${base64Body}\n-----END RSA PRIVATE KEY-----`;
}

function toSpkiPublicPem(base64Body) {
  return `-----BEGIN PUBLIC KEY-----\n${base64Body}\n-----END PUBLIC KEY-----`;
}

const privateKeyObject = crypto.createPrivateKey({
  key: toPkcs1PrivatePem(RSA_PRIVATE_KEY_BASE64),
  format: "pem",
});

/**
 * @param {string} encryptedFlag - 响应头 encrypt-flag（JSEncrypt 公钥加密后的 Base64）
 * @param {string} encryptedData - 响应体密文（CryptoJS AES.encrypt().toString() 预设为 Base64）
 * @param {import('crypto').KeyObject} [privateKey] - 可选，预设使用打包内私钥
 * @returns {object} JSON 对象
 */
export function decryptResponse(encryptedFlag, encryptedData, privateKey = privateKeyObject) {
  const flagBuf = Buffer.from(String(encryptedFlag).replace(/\s+/g, ""), "base64");
  const rsaPlain = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    flagBuf
  );
  const aesKeyBase64 = rsaPlain.toString("utf8");
  const aesKey = Buffer.from(aesKeyBase64, "base64");
  if (aesKey.length !== 16 && aesKey.length !== 24 && aesKey.length !== 32) {
    throw new Error(
      `AES key length ${aesKey.length} not 16/24/32; check encrypt-flag / RSA padding`
    );
  }
  const cipherBuf = Buffer.from(String(encryptedData).replace(/\s+/g, ""), "base64");
  const decipher = crypto.createDecipheriv(`aes-${aesKey.length * 8}-ecb`, aesKey, null);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * 随机生成 32 字节 AES-256 密钥（对应前端 generateAesKey）。
 * @returns {Buffer}
 */
export function generateAesKey() {
  return crypto.randomBytes(32);
}

/**
 * 与前端一致的「请求」加密：每请求生成新 AES 密钥，RSA 公钥加密后作为请求头 encrypt-flag，
 * 明文字符串经 AES-256-ECB 加密后作为 params（Base64，且 + → %2B）。
 *
 * @param {string} plainText - 待加密明文（查询串或 JSON 字符串，须与前端一致）
 * @param {string} [publicKeyPem] - RSA SPKI PEM，默认使用打包公钥
 * @param {{ paramsEncoding?: "plus" | "uri" }} [options]
 *   - `plus`（默认）：仅将 Base64 中的 `+` 转为 `%2B`（与常见前端 replace 一致）
 *   - `uri`：对整段 Base64 做 `encodeURIComponent`（同时编码 `+/=`，避免 query 解析截断导致服务端 500）
 * @returns {{ encryptFlag: string, paramsQueryValue: string }}
 */
export function encryptRequest(
  plainText,
  publicKeyPem = toSpkiPublicPem(RSA_PUBLIC_KEY_BASE64),
  options = {}
) {
  const aesKey = generateAesKey();
  const aesKeyBase64 = aesKey.toString("base64");
  const pub = crypto.createPublicKey({ key: publicKeyPem, format: "pem" });
  const encryptFlag = crypto
    .publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(aesKeyBase64, "utf8")
    )
    .toString("base64");

  const cipher = crypto.createCipheriv("aes-256-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const encryptedBase64 = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]).toString("base64");

  const mode = options.paramsEncoding === "uri" ? "uri" : "plus";
  const paramsQueryValue =
    mode === "uri"
      ? encodeURIComponent(encryptedBase64)
      : encryptedBase64.replaceAll("+", "%2B");

  return { encryptFlag, paramsQueryValue };
}

/** 用于本地验证：与前端相同路径加密一轮后再解密 */
export function encryptResponseForTest(plainObject, publicKeyPem = toSpkiPublicPem(RSA_PUBLIC_KEY_BASE64)) {
  const json = JSON.stringify(plainObject);
  const aesKey = crypto.randomBytes(32);
  const aesKeyBase64 = aesKey.toString("base64");
  const pub = crypto.createPublicKey({ key: publicKeyPem, format: "pem" });
  const encryptedFlag = crypto
    .publicEncrypt(
      { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(aesKeyBase64, "utf8")
    )
    .toString("base64");
  const cipher = crypto.createCipheriv("aes-256-ecb", aesKey, null);
  cipher.setAutoPadding(true);
  const encryptedData = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]).toString(
    "base64"
  );
  return { encryptedFlag, encryptedData };
}

const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  path.resolve(__filename) === path.resolve(process.argv[1]);

if (isMain) {
  const reqPlain = "pageNum=1&pageSize=20";
  const { encryptFlag: reqEncFlag, paramsQueryValue } = encryptRequest(reqPlain);
  const reqFlagBuf = Buffer.from(String(reqEncFlag).replace(/\s+/g, ""), "base64");
  const rsaPlainReq = crypto.privateDecrypt(
    { key: privateKeyObject, padding: crypto.constants.RSA_PKCS1_PADDING },
    reqFlagBuf
  );
  const aesKeyFromFlag = Buffer.from(rsaPlainReq.toString("utf8"), "base64");
  let paramsB64 = String(paramsQueryValue).replace(/\s+/g, "");
  try {
    if (/%2[Ff]|%3[Dd]/.test(paramsB64)) {
      paramsB64 = decodeURIComponent(paramsB64);
    } else {
      paramsB64 = paramsB64.replaceAll("%2B", "+");
    }
  } catch {
    paramsB64 = String(paramsQueryValue).replaceAll("%2B", "+").replace(/\s+/g, "");
  }
  const paramsBuf = Buffer.from(paramsB64, "base64");
  const reqDecipher = crypto.createDecipheriv(
    `aes-${aesKeyFromFlag.length * 8}-ecb`,
    aesKeyFromFlag,
    null
  );
  reqDecipher.setAutoPadding(true);
  const reqDecrypted = Buffer.concat([reqDecipher.update(paramsBuf), reqDecipher.final()]).toString("utf8");
  console.log(
    "encryptRequest self-test:",
    reqDecrypted === reqPlain ? "OK" : "FAIL",
    reqDecrypted
  );

  const sample = { code: 200, msg: "ok", data: { n: 1 } };
  const { encryptedFlag, encryptedData } = encryptResponseForTest(sample);
  const out = decryptResponse(encryptedFlag, encryptedData);
  console.log("self-test roundtrip:", JSON.stringify(out) === JSON.stringify(sample) ? "OK" : "FAIL");
  console.log("decrypted:", out);

  const ef = process.env.ENCRYPT_FLAG;
  const ed = process.env.ENCRYPTED_DATA;
  if (ef && ed) {
    console.log("env decrypt:", decryptResponse(ef, ed));
  }
}
