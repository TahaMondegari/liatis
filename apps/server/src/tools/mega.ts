import { z } from "zod";
import type { ToolDef } from "../ai/gateway.js";
import type { LiaraRequest } from "../liara/transport.js";

/**
 * Domain Mega Tools (BRIEF §6.2). The LLM sees ~14 tools with explicit
 * `action` enums. Each action maps to exactly one verified capability and a
 * request builder; there are no raw paths, shell strings or SQL in arguments.
 */
export interface ActionDef {
  cap: string;
  /** zod schema for this action's arguments */
  args: z.ZodObject<z.ZodRawShape>;
  build: (a: Record<string, unknown>) => { req: LiaraRequest; resource: string; title: string; effect: string };
  describe: string;
}

const name = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "invalid resource name");
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, "invalid id");
const domain = z.string().regex(/^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i, "invalid domain");
const since = z.number().int().min(60).max(7 * 86400).default(3600);
const nowSec = () => Math.floor(Date.now() / 1000);

const A = (cap: string, describe: string, args: z.ZodRawShape, build: ActionDef["build"]): ActionDef => ({ cap, describe, args: z.object(args).strict(), build });

export const MEGA_TOOLS: Record<string, { description: string; actions: Record<string, ActionDef> }> = {
  liara_app: {
    description: "Liara PaaS apps: status, logs, events, releases, metrics, restart, start/stop, plan change, platform settings.",
    actions: {
      list: A("paas.getApps", "list all apps", {}, () => ({ req: {}, resource: "*", title: "فهرست برنامه‌ها", effect: "read" })),
      status: A("paas.getAppByName", "app details (env values redacted)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: "وضعیت برنامه", effect: "read" })),
      logs: A("paas.getAppLogs", "recent logs (condensed)", { app: name, seconds: since }, (a) => ({ req: { pathParams: { name: a.app as string }, query: { since: String(nowSec() - Number(a.seconds ?? 3600)) } }, resource: a.app as string, title: "لاگ‌ها", effect: "read" })),
      events: A("paas.getAppEvents", "platform events (restarts, OOM)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: "رویدادها", effect: "read" })),
      applets: A("paas.getAppApplets", "container states", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: "کانتینرها", effect: "read" })),
      releases: A("paas.getAppReleases", "release history", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string }, query: { page: 1, count: 10 } }, resource: a.app as string, title: "نسخه‌ها", effect: "read" })),
      metrics_summary: A("paas.getAppSummaryReports", "current cpu/memory/disk", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: "مصرف منابع", effect: "read" })),
      cpu: A("paas.getAppCpuReports", "cpu series", { app: name, seconds: since }, (a) => ({ req: { pathParams: { name: a.app as string }, query: { since: nowSec() - Number(a.seconds ?? 3600) } }, resource: a.app as string, title: "پردازنده", effect: "read" })),
      memory: A("paas.getAppMemoryReports", "memory series (bytes)", { app: name, seconds: since }, (a) => ({ req: { pathParams: { name: a.app as string }, query: { since: nowSec() - Number(a.seconds ?? 3600) } }, resource: a.app as string, title: "حافظه", effect: "read" })),
      restart: A("paas.restartApp", "restart (service-affecting)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: `ری‌استارت ${a.app}`, effect: "کانتینرها دوباره راه‌اندازی می‌شن؛ چند ثانیه قطعی." })),
      start: A("paas.turnApp", "turn on (scale=1)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string }, body: { scale: 1 } }, resource: a.app as string, title: `روشن کردن ${a.app}`, effect: "برنامه روشن می‌شه و هزینه‌ی ساعتی شروع می‌شه." })),
      stop: A("paas.turnApp", "turn off (scale=0, downtime)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string }, body: { scale: 0 } }, resource: a.app as string, title: `خاموش کردن ${a.app}`, effect: "سایت از دسترس خارج می‌شه." })),
      change_plan: A("paas.changePlan", "change hardware plan (cost)", { app: name, plan_id: id }, (a) => ({ req: { pathParams: { name: a.app as string }, body: { planID: a.plan_id } }, resource: a.app as string, title: `تغییر پلن ${a.app} به ${a.plan_id}`, effect: "پلن عوض می‌شه، هزینه تغییر می‌کنه و برنامه ری‌استارت می‌شه." })),
      zero_downtime: A("paas.zeroDowntime", "enable/disable zero-downtime deploy", { app: name, enabled: z.boolean() }, (a) => ({ req: { pathParams: { id: a.app as string, status: a.enabled ? "enable" : "disable" } }, resource: a.app as string, title: `دپلوی بدون اختلال: ${a.enabled ? "روشن" : "خاموش"}`, effect: "روش انتشار نسخه‌های بعدی تغییر می‌کنه." })),
      default_subdomain: A("paas.defaultSubdomain", "enable/disable <app>.liara.run", { app: name, enabled: z.boolean() }, (a) => ({ req: { pathParams: { id: a.app as string, status: a.enabled ? "enable" : "disable" } }, resource: a.app as string, title: `زیردامنه‌ی پیش‌فرض: ${a.enabled ? "روشن" : "خاموش"}`, effect: "دسترسی عمومی از آدرس liara.run تغییر می‌کنه." })),
      delete: A("paas.deleteAppByName", "DELETE app (irreversible)", { app: name }, (a) => ({ req: { pathParams: { name: a.app as string } }, resource: a.app as string, title: `حذف برنامه ${a.app}`, effect: "برنامه و همه‌ی تنظیماتش برای همیشه حذف می‌شه." })),
    },
  },
  liara_disk: {
    description: "Disks attached to PaaS apps: list, backups, create/resize/delete.",
    actions: {
      list: A("paas.getDisks", "list disks", { app: name }, (a) => ({ req: { pathParams: { id: a.app as string } }, resource: a.app as string, title: "دیسک‌ها", effect: "read" })),
      backups: A("paas.getBackups", "disk backups", { app: name, disk: name }, (a) => ({ req: { pathParams: { id: a.app as string, name: a.disk as string } }, resource: `${a.app}/${a.disk}`, title: "بکاپ‌های دیسک", effect: "read" })),
      create_backup: A("paas.createBackup", "back up a disk", { app: name, disk: name }, (a) => ({ req: { pathParams: { id: a.app as string, name: a.disk as string } }, resource: `${a.app}/${a.disk}`, title: "بکاپ‌گیری دیسک", effect: "یک بکاپ جدید ساخته می‌شه." })),
      create: A("paas.createDisk", "create disk (cost)", { app: name, disk: name, size_gb: z.number().int().min(1).max(500) }, (a) => ({ req: { pathParams: { name: a.app as string }, body: { name: a.disk, size: String(a.size_gb) } }, resource: `${a.app}/${a.disk}`, title: `ساخت دیسک ${a.disk} (${a.size_gb}GB)`, effect: "دیسک جدید با هزینه ساخته می‌شه." })),
      resize: A("paas.resizeDisk", "resize disk (cost)", { app: name, disk: name, size_gb: z.number().int().min(1).max(500) }, (a) => ({ req: { pathParams: { name: a.app as string, dname: a.disk as string }, body: { size: String(a.size_gb) } }, resource: `${a.app}/${a.disk}`, title: `تغییر اندازه‌ی دیسک ${a.disk}`, effect: "حجم دیسک و هزینه تغییر می‌کنه." })),
      delete: A("paas.deleteDisk", "DELETE disk (irreversible)", { app: name, disk: name }, (a) => ({ req: { pathParams: { id: a.app as string, name: a.disk as string } }, resource: a.disk as string, title: `حذف دیسک ${a.disk}`, effect: "همه‌ی فایل‌های دیسک برای همیشه پاک می‌شن." })),
    },
  },
  liara_domain: {
    description: "Domains of PaaS apps: list, check, add, attach, SSL, redirect, remove.",
    actions: {
      list: A("paas.getAppDomains", "domains of an app", { app: name }, (a) => ({ req: { query: { project: a.app as string } }, resource: a.app as string, title: "دامنه‌ها", effect: "read" })),
      check: A("paas.checkDomain", "check domain status by domain id", { domain_id: id }, (a) => ({ req: { pathParams: { id: a.domain_id as string } }, resource: a.domain_id as string, title: "بررسی دامنه", effect: "read" })),
      add: A("paas.createAppDomain", "add a domain to an app", { app: name, domain, type: z.enum(["ROOT", "SUBDOMAIN"]).default("ROOT") }, (a) => ({ req: { body: { name: a.domain, project: a.app, type: a.type ?? "ROOT" } }, resource: a.domain as string, title: `افزودن دامنه‌ی ${a.domain} به ${a.app}`, effect: "دامنه به برنامه اضافه می‌شه؛ بعدش باید رکورد DNS تنظیم بشه." })),
      enable_ssl: A("paas.enableSsl", "issue SSL certificate", { domain }, (a) => ({ req: { body: { domain: a.domain } }, resource: a.domain as string, title: `صدور SSL برای ${a.domain}`, effect: "گواهی رایگان صادر می‌شه." })),
      disable_ssl: A("paas.disableSsl", "disable SSL", { domain_id: id }, (a) => ({ req: { pathParams: { id: a.domain_id as string } }, resource: a.domain_id as string, title: "غیرفعال کردن SSL", effect: "سایت روی https در دسترس نیست." })),
      redirect: A("paas.redirectDomain", "redirect domain", { domain_id: id, to: z.string().url(), status: z.union([z.literal(301), z.literal(302)]).default(301) }, (a) => ({ req: { pathParams: { id: a.domain_id as string }, body: { redirectTo: a.to, redirectStatus: a.status ?? 301 } }, resource: a.domain_id as string, title: `ریدایرکت به ${a.to}`, effect: "همه‌ی درخواست‌ها ریدایرکت می‌شن." })),
      remove: A("paas.deleteDomain", "remove domain", { domain_id: id }, (a) => ({ req: { pathParams: { id: a.domain_id as string } }, resource: a.domain_id as string, title: "حذف دامنه", effect: "دامنه از برنامه جدا می‌شه." })),
    },
  },
  liara_dns: {
    description: "Liara DNS zones and records.",
    actions: {
      zones: A("dns.getListZones", "list zones", {}, () => ({ req: {}, resource: "*", title: "زون‌ها", effect: "read" })),
      zone: A("dns.getZone", "zone details", { zone: domain }, (a) => ({ req: { pathParams: { zone: a.zone as string } }, resource: a.zone as string, title: "زون", effect: "read" })),
      records: A("dns.getListDnsRecords", "records of a zone", { zone: domain }, (a) => ({ req: { pathParams: { zone: a.zone as string } }, resource: a.zone as string, title: "رکوردها", effect: "read" })),
      check_nameservers: A("dns.checkNameServer", "re-check nameservers", { zone: domain }, (a) => ({ req: { pathParams: { zone: a.zone as string } }, resource: a.zone as string, title: "بررسی نیم‌سرورها", effect: "وضعیت نیم‌سرورها دوباره چک می‌شه." })),
      create_zone: A("dns.createZone", "create zone", { zone: domain }, (a) => ({ req: { body: { name: a.zone } }, resource: a.zone as string, title: `ساخت زون ${a.zone}`, effect: "زون DNS ساخته می‌شه؛ نیم‌سرورها باید در ثبت‌کننده عوض بشن." })),
      create_record: A("dns.createDnsRecord", "create record", { zone: domain, name: z.string().max(253), type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "ALIAS"]), ttl: z.number().int().min(60).max(86400).default(3600), contents: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(10) }, (a) => ({ req: { pathParams: { zone: a.zone as string }, body: { name: a.name, type: a.type, ttl: a.ttl ?? 3600, contents: a.contents } }, resource: `${a.name}.${a.zone}`, title: `ساخت رکورد ${a.type} ${a.name}`, effect: "رکورد DNS عمومی ساخته می‌شه." })),
      edit_record: A("dns.editDnsRecord", "edit record (type immutable)", { zone: domain, record_id: id, name: z.string().max(253), type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "ALIAS"]), ttl: z.number().int().min(60).max(86400).default(3600), contents: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(10) }, (a) => ({ req: { pathParams: { zone: a.zone as string, id: a.record_id as string }, body: { name: a.name, type: a.type, ttl: a.ttl ?? 3600, contents: a.contents } }, resource: `${a.name}.${a.zone}`, title: `ویرایش رکورد ${a.name}`, effect: "رکورد DNS عمومی تغییر می‌کنه." })),
      delete_record: A("dns.deleteDnsRecord", "delete record", { zone: domain, record_id: id }, (a) => ({ req: { pathParams: { zone: a.zone as string, id: a.record_id as string } }, resource: `${a.zone}/${a.record_id}`, title: "حذف رکورد DNS", effect: "رکورد حذف می‌شه." })),
      delete_zone: A("dns.deleteZone", "DELETE zone (irreversible)", { zone: domain }, (a) => ({ req: { pathParams: { zone: a.zone as string } }, resource: a.zone as string, title: `حذف زون ${a.zone}`, effect: "زون و همه‌ی رکوردها برای همیشه حذف می‌شن." })),
    },
  },
  liara_database: {
    description: "Liara DBaaS: list, details (passwords redacted), backups, metrics, events, power, resize, network.",
    actions: {
      list: A("dbaas.getListDatabases", "list databases", {}, () => ({ req: {}, resource: "*", title: "دیتابیس‌ها", effect: "read" })),
      get: A("dbaas.getDatabase", "database details", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string } }, resource: a.database_id as string, title: "دیتابیس", effect: "read" })),
      backups: A("dbaas.getListBackups", "backups", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string } }, resource: a.database_id as string, title: "بکاپ‌ها", effect: "read" })),
      metrics: A("dbaas.getDatabaseSummaryReports", "resource summary", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string } }, resource: a.database_id as string, title: "مصرف دیتابیس", effect: "read" })),
      events: A("dbaas.getDatabaseEvents", "events", { hostname: name }, (a) => ({ req: { pathParams: { name: a.hostname as string } }, resource: a.hostname as string, title: "رویدادهای دیتابیس", effect: "read" })),
      create_backup: A("dbaas.createBackup", "create backup", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string } }, resource: a.database_id as string, title: "بکاپ‌گیری از دیتابیس", effect: "یک بکاپ جدید ساخته می‌شه." })),
      start: A("dbaas.TurnDatabase", "power on", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string }, body: { scale: 1 } }, resource: a.database_id as string, title: "روشن کردن دیتابیس", effect: "دیتابیس روشن می‌شه." })),
      stop: A("dbaas.TurnDatabase", "power off (downtime)", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string }, body: { scale: 0 } }, resource: a.database_id as string, title: "خاموش کردن دیتابیس", effect: "برنامه‌های وابسته قطع می‌شن." })),
      resize: A("dbaas.resizeDatabase", "change plan (cost)", { database_id: id, plan_id: id, disk: z.boolean().default(false) }, (a) => ({ req: { pathParams: { id: a.database_id as string }, body: { planID: a.plan_id, disk: a.disk ?? false } }, resource: a.database_id as string, title: `تغییر پلن دیتابیس به ${a.plan_id}`, effect: "پلن و هزینه تغییر می‌کنه؛ ممکنه کوتاه قطع بشه." })),
      public_network: A("dbaas.changePublicNetwork", "enable/disable public access", { database_id: id, enabled: z.boolean() }, (a) => ({ req: { pathParams: { id: a.database_id as string, status: a.enabled ? "enable" : "disable" } }, resource: a.database_id as string, title: `دسترسی عمومی دیتابیس: ${a.enabled ? "روشن" : "خاموش"}`, effect: a.enabled ? "دیتابیس از اینترنت قابل دسترس می‌شه." : "دسترسی عمومی قطع می‌شه." })),
      delete: A("dbaas.deleteDatabase", "DELETE database (irreversible)", { database_id: id }, (a) => ({ req: { pathParams: { id: a.database_id as string } }, resource: a.database_id as string, title: "حذف دیتابیس", effect: "همه‌ی داده‌ها برای همیشه پاک می‌شن و برگشتی نداره." })),
    },
  },
  liara_storage: {
    description: "Liara Object Storage buckets and objects (metadata only).",
    actions: {
      buckets: A("storage.getBuckets", "list buckets", {}, () => ({ req: {}, resource: "*", title: "باکت‌ها", effect: "read" })),
      bucket: A("storage.getSingleBuckets", "bucket details", { bucket: name }, (a) => ({ req: { pathParams: { bucket: a.bucket as string } }, resource: a.bucket as string, title: "باکت", effect: "read" })),
      objects: A("storage.getListObjects", "list objects under prefix", { bucket: name, prefix: z.string().max(512).default("/") }, (a) => ({ req: { pathParams: { bucket: a.bucket as string, prefix: String(a.prefix || "/") } }, resource: a.bucket as string, title: "فایل‌ها", effect: "read" })),
      metrics: A("storage.getMetricsSummary", "usage summary", { bucket: name }, (a) => ({ req: { pathParams: { bucket: a.bucket as string } }, resource: a.bucket as string, title: "مصرف باکت", effect: "read" })),
      create: A("storage.createBucket", "create bucket (cost)", { bucket: name, plan: id, permission: z.enum(["private", "public-read"]).default("private") }, (a) => ({ req: { body: { name: a.bucket, plan: a.plan, permission: a.permission ?? "private" } }, resource: a.bucket as string, title: `ساخت باکت ${a.bucket}`, effect: "باکت جدید ساخته می‌شه." })),
      set_access: A("storage.changeBucketAccess", "public/private", { bucket: name, permission: z.enum(["private", "public-read"]) }, (a) => ({ req: { pathParams: { bucket: a.bucket as string, permission: a.permission as string } }, resource: a.bucket as string, title: `دسترسی باکت: ${a.permission}`, effect: a.permission === "private" ? "لینک‌های عمومی از کار می‌افتن." : "همه‌ی فایل‌ها عمومی می‌شن." })),
      delete: A("storage.destroyBucket", "DELETE bucket (irreversible)", { bucket: name }, (a) => ({ req: { pathParams: { bucket: a.bucket as string } }, resource: a.bucket as string, title: `حذف باکت ${a.bucket}`, effect: "باکت و همه‌ی فایل‌ها برای همیشه حذف می‌شن." })),
    },
  },
  liara_mail: {
    description: "Liara Mail servers: list, details, DNS status, usage (mailbox content is never read).",
    actions: {
      servers: A("mail.getMails", "list mail servers", {}, () => ({ req: {}, resource: "*", title: "میل‌سرورها", effect: "read" })),
      server: A("mail.getSingleMailServer", "mail server details", { mail_server_id: id }, (a) => ({ req: { pathParams: { mailServerID: a.mail_server_id as string } }, resource: a.mail_server_id as string, title: "میل‌سرور", effect: "read" })),
      dns_status: A("mail.checkMailServerDnsStatus", "DNS (SPF/DKIM/MX) status", { mail_server_id: id }, (a) => ({ req: { pathParams: { mailServerID: a.mail_server_id as string } }, resource: a.mail_server_id as string, title: "وضعیت DNS میل‌سرور", effect: "read" })),
      accounts: A("mail.getAllMailAccounts", "mail accounts", { mail_server_id: id }, (a) => ({ req: { pathParams: { mailServerID: a.mail_server_id as string } }, resource: a.mail_server_id as string, title: "حساب‌ها", effect: "read" })),
      usage: A("mail.getMetrics", "usage metrics", { mail_server_id: id }, (a) => ({ req: { pathParams: { mailServerID: a.mail_server_id as string } }, resource: a.mail_server_id as string, title: "مصرف", effect: "read" })),
    },
  },
  liara_iaas: {
    description: "Liara cloud VMs: list, details (password redacted), plans, OS list, operations, traffic, power, resize, delete.",
    actions: {
      list: A("iaas.getVMs", "list VMs", {}, () => ({ req: {}, resource: "*", title: "سرورهای مجازی", effect: "read" })),
      get: A("iaas.getVMDetails", "VM details", { vm_id: id }, (a) => ({ req: { pathParams: { id: a.vm_id as string } }, resource: a.vm_id as string, title: "سرور مجازی", effect: "read" })),
      plans: A("iaas.getPlans", "VM plans with prices", {}, () => ({ req: {}, resource: "*", title: "پلن‌های سرور", effect: "read" })),
      os: A("iaas.getOperatingSystems", "available OS images", {}, () => ({ req: {}, resource: "*", title: "سیستم‌عامل‌ها", effect: "read" })),
      operations: A("iaas.getVMOperations", "operation log", { vm_id: id }, (a) => ({ req: { pathParams: { id: a.vm_id as string } }, resource: a.vm_id as string, title: "عملیات‌ها", effect: "read" })),
      traffic: A("iaas.getVMTrafficVolume", "traffic volume", { vm_id: id }, (a) => ({ req: { pathParams: { id: a.vm_id as string } }, resource: a.vm_id as string, title: "ترافیک", effect: "read" })),
      power: A("iaas.setVMPower", "power action", { vm_id: id, power: z.enum(["start", "stop", "restart", "shutdown"]) }, (a) => ({ req: { pathParams: { id: a.vm_id as string }, body: { action: a.power } }, resource: a.vm_id as string, title: `سرور مجازی: ${a.power}`, effect: "وضعیت روشن/خاموش سرور تغییر می‌کنه." })),
      resize: A("iaas.resizeVM", "change VM plan (cost)", { vm_id: id, plan: z.enum(["standard-base-g2", "standard-plus-g2", "pro-g2", "pro-plus-g2", "express-g2", "express-plus-g2"]) }, (a) => ({ req: { pathParams: { id: a.vm_id as string }, body: { plan: a.plan } }, resource: a.vm_id as string, title: `تغییر پلن سرور به ${a.plan}`, effect: "منابع و هزینه تغییر می‌کنه." })),
      delete: A("iaas.deleteVM", "DELETE VM (irreversible)", { vm_id: id }, (a) => ({ req: { pathParams: { id: a.vm_id as string } }, resource: a.vm_id as string, title: "حذف سرور مجازی", effect: "سرور و دیسک‌هاش برای همیشه حذف می‌شن." })),
    },
  },
  liara_billing: {
    description: "Wallet balance and account/plan information (top-up is NOT available via API).",
    actions: {
      balance: A("billing.getBilling", "wallet balance", {}, () => ({ req: {}, resource: "*", title: "موجودی", effect: "read" })),
      free_credit: A("account.getMeFreeCredit", "remaining free credit", {}, () => ({ req: {}, resource: "*", title: "اعتبار رایگان", effect: "read" })),
      subscription: A("account.getMeSubscription", "support subscription", {}, () => ({ req: {}, resource: "*", title: "اشتراک", effect: "read" })),
    },
  },
  liara_ai: {
    description: "Liara AI workspaces: usage/cost activity, model limits, free tokens, API keys (metadata), request logs, model catalog.",
    actions: {
      workspaces: A("ai_workspaces.listWorkspaces", "list AI workspaces", {}, () => ({ req: {}, resource: "*", title: "ورک‌اسپیس‌ها", effect: "read" })),
      activity: A("ai_workspaces.getWorkspaceActivity", "usage by model/day", { workspace_id: id, filter: z.enum(["hour", "day", "week", "month", "twoMonth"]).default("week") }, (a) => ({ req: { pathParams: { workspaceID: a.workspace_id as string }, query: { filter: (a.filter as string) ?? "week" } }, resource: a.workspace_id as string, title: "مصرف هوش مصنوعی", effect: "read" })),
      free_tokens: A("ai_workspaces.getFreeTokens", "free token usage", { workspace_id: id }, (a) => ({ req: { pathParams: { workspaceID: a.workspace_id as string } }, resource: a.workspace_id as string, title: "توکن رایگان", effect: "read" })),
      model_limits: A("ai_workspaces.getModelLimits", "limits for a model", { workspace_id: id, model: z.string().regex(/^[\w./-]{2,80}$/) }, (a) => ({ req: { pathParams: { workspaceID: a.workspace_id as string, modelID: a.model as string } }, resource: a.workspace_id as string, title: "محدودیت مدل", effect: "read" })),
      keys: A("ai_keys.listKeys", "API keys (no secrets)", {}, () => ({ req: {}, resource: "*", title: "کلیدها", effect: "read" })),
      logs: A("ai_logs.listLogs", "request logs", { workspace_id: id }, (a) => ({ req: { pathParams: { workspaceID: a.workspace_id as string }, query: { page: 1, count: 20 } }, resource: a.workspace_id as string, title: "لاگ درخواست‌ها", effect: "read" })),
      provider_preference: A("ai_workspaces.changeProviderPreferences", "routing preference", { workspace_id: id, preference: z.enum(["price", "throughput", "latency"]) }, (a) => ({ req: { pathParams: { workspaceID: a.workspace_id as string }, body: { preference: a.preference } }, resource: a.workspace_id as string, title: `ترجیح مسیریابی: ${a.preference}`, effect: "مسیر درخواست‌ها به ارائه‌دهنده‌ها تغییر می‌کنه." })),
    },
  },
};

/** Builds OpenAI-style tool definitions; parameters merge the per-action argument shapes. */
export function toolDefs(extra: ToolDef[] = []): ToolDef[] {
  const defs: ToolDef[] = Object.entries(MEGA_TOOLS).map(([tool, t]) => {
    const props: Record<string, unknown> = { action: { type: "string", enum: Object.keys(t.actions), description: Object.entries(t.actions).map(([k, a]) => `${k}: ${a.describe}`).join("; ") } };
    for (const a of Object.values(t.actions)) {
      const js = z.toJSONSchema(a.args) as { properties?: Record<string, unknown> };
      for (const [k, v] of Object.entries(js.properties ?? {})) props[k] ??= v;
    }
    return { type: "function", function: { name: tool, description: t.description, parameters: { type: "object", properties: props, required: ["action"], additionalProperties: false } } };
  });
  return [...defs, ...extra];
}
