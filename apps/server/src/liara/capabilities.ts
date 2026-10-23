import type { CapabilityStatus, CapabilityView, RiskLevel } from "@liara-agent/shared";
import { GENERATED_OPERATIONS, type GeneratedOperation } from "./operations.generated.js";

/**
 * Capability Registry (BRIEF §5.2).
 *
 * Executable capabilities come ONLY from the generated OpenAPI inventory.
 * This file adds human judgment on top: risk level, Persian label, whether the
 * LLM may reach it through a Mega Tool, and caveats. Anything not listed in the
 * OpenAPI inventory is recorded below as `unsupported` with a manual path.
 */
type Meta = [risk: RiskLevel, labelFa: string, opts?: { agent?: boolean; note?: string; idempotent?: boolean; secretResponse?: boolean; status?: CapabilityStatus }];

const META: Record<string, Meta> = {
  // ---- PaaS ---------------------------------------------------------------
  "paas.getApps": ["L0", "فهرست برنامه‌ها"],
  "paas.createApp": ["L3", "ساخت برنامه‌ی جدید", { note: "Body per spec: name, planID, platform, readOnlyRootFilesystem, network. Bundle plan selection is not part of the published schema." }],
  "paas.getAppByName": ["L0", "جزئیات برنامه", { secretResponse: true, note: "Response includes env values; values are redacted before leaving the client." }],
  "paas.deleteAppByName": ["L4", "حذف برنامه"],
  "paas.turnApp": ["L2", "روشن/خاموش کردن برنامه", { note: "scale=0 stops the app (downtime)." }],
  "paas.restartApp": ["L2", "ری‌استارت برنامه"],
  "paas.sourcesDeploy": ["L1", "آپلود سورس برای دپلوی", { note: "Uploads a .tar.gz; does not change the running release by itself." }],
  "paas.releasesDeploy": ["L2", "ساخت و انتشار نسخه‌ی جدید"],
  "paas.zeroDowntime": ["L2", "تنظیم دپلوی بدون اختلال"],
  "paas.defaultSubdomain": ["L3", "فعال/غیرفعال کردن زیردامنه‌ی پیش‌فرض", { note: "Changes public exposure." }],
  "paas.ipStatic": ["L3", "IP ثابت", { note: "May incur cost; price not exposed by the API." }],
  "paas.readOnly": ["L2", "فایل‌سیستم فقط‌خواندنی"],
  "paas.updateEnvs": ["L2", "به‌روزرسانی متغیرهای محیطی", { note: "Liara restarts the app to apply envs." }],
  "paas.changePlan": ["L3", "تغییر پلن برنامه"],
  "paas.getFtps": ["L0", "دسترسی‌های FTP دیسک", { secretResponse: true }],
  "paas.createFtp": ["L2", "ساخت دسترسی FTP", { secretResponse: true, note: "Generated password is never shown to the model; user must read it in the Liara console." }],
  "paas.getDisks": ["L0", "دیسک‌های برنامه"],
  "paas.getBackups": ["L0", "بکاپ‌های دیسک"],
  "paas.createBackup": ["L1", "بکاپ‌گیری از دیسک"],
  "paas.downloadBackup": ["L1", "لینک دانلود بکاپ دیسک"],
  "paas.resizeDisk": ["L3", "تغییر اندازه‌ی دیسک"],
  "paas.createDisk": ["L3", "ساخت دیسک"],
  "paas.deleteDisk": ["L4", "حذف دیسک"],
  "paas.deleteFtp": ["L3", "حذف دسترسی FTP"],
  "paas.checkDomain": ["L0", "بررسی وضعیت دامنه"],
  "paas.getAppLogs": ["L0", "لاگ‌های برنامه"],
  "paas.getAppEvents": ["L0", "رویدادهای برنامه"],
  "paas.getAppApplets": ["L0", "وضعیت کانتینرها"],
  "paas.getAppReleases": ["L0", "نسخه‌های منتشرشده"],
  "paas.getAppSummaryReports": ["L0", "خلاصه‌ی مصرف منابع"],
  "paas.getAppCpuReports": ["L0", "گزارش پردازنده"],
  "paas.getAppMemoryReports": ["L0", "گزارش حافظه"],
  "paas.getAppNetworkReceiveReports": ["L0", "گزارش ترافیک ورودی"],
  "paas.getNetworkTransmitReports": ["L0", "گزارش ترافیک خروجی"],
  "paas.getAppDomains": ["L0", "دامنه‌ها"],
  "paas.createAppDomain": ["L3", "افزودن دامنه"],
  "paas.setAppDomain": ["L3", "اتصال دامنه به برنامه"],
  "paas.redirectDomain": ["L3", "ریدایرکت دامنه"],
  "paas.disableSsl": ["L3", "غیرفعال کردن SSL"],
  "paas.enableSsl": ["L2", "صدور گواهی SSL"],
  "paas.deleteDomain": ["L3", "حذف دامنه از برنامه"],
  // ---- DBaaS --------------------------------------------------------------
  "dbaas.getDatabase": ["L0", "جزئیات دیتابیس", { secretResponse: true }],
  "dbaas.deleteDatabase": ["L4", "حذف دیتابیس"],
  "dbaas.getListDatabases": ["L0", "فهرست دیتابیس‌ها"],
  "dbaas.createDatabase": ["L3", "ساخت دیتابیس"],
  "dbaas.TurnDatabase": ["L2", "روشن/خاموش کردن دیتابیس"],
  "dbaas.resizeDatabase": ["L3", "تغییر پلن دیتابیس"],
  "dbaas.getListBackups": ["L0", "بکاپ‌های دیتابیس"],
  "dbaas.createBackup": ["L1", "بکاپ‌گیری از دیتابیس"],
  "dbaas.databasesSettings": ["L2", "تنظیمات دیتابیس"],
  "dbaas.downloadBackup": ["L1", "لینک دانلود بکاپ دیتابیس"],
  "dbaas.changeControlPanel": ["L2", "پنل مدیریت دیتابیس"],
  "dbaas.changePublicNetwork": ["L3", "دسترسی عمومی دیتابیس", { note: "Public exposure change." }],
  "dbaas.getDatabaseCpuReports": ["L0", "گزارش پردازنده‌ی دیتابیس"],
  "dbaas.getDatabaseMemoryReports": ["L0", "گزارش حافظه‌ی دیتابیس"],
  "dbaas.getDatabaseNetworkReceiveReports": ["L0", "ترافیک ورودی دیتابیس"],
  "dbaas.getDatabaseNetworkTransmitReports": ["L0", "ترافیک خروجی دیتابیس"],
  "dbaas.getDatabaseSummaryReports": ["L0", "خلاصه‌ی مصرف دیتابیس"],
  "dbaas.getDatabaseEvents": ["L0", "رویدادهای دیتابیس"],
  // ---- Database inspector (per-resource host) -----------------------------
  "dbinspector.getAllRoles": ["L0", "نقش‌های دیتابیس"],
  "dbinspector.createRole": ["L3", "ساخت نقش دیتابیس", { agent: false, note: "Requires a password value; not exposed to the model." }],
  "dbinspector.updateRole": ["L3", "ویرایش نقش دیتابیس", { agent: false }],
  "dbinspector.deleteRole": ["L4", "حذف نقش دیتابیس", { agent: false }],
  "dbinspector.getAllDatasets": ["L0", "جدول‌های دیتابیس"],
  "dbinspector.getDatasetByName": ["L0", "داده‌های یک جدول", { agent: false, note: "May return personal data; not sent to the model." }],
  "dbinspector.queries": ["L4", "اجرای کوئری دلخواه", { agent: false, note: "Arbitrary SQL is forbidden for the agent (BRIEF §6.2)." }],
  "dbinspector.filterDataset": ["L0", "فیلتر داده", { agent: false }],
  "dbinspector.createData": ["L3", "افزودن داده", { agent: false, note: "Request body is not described in the spec." }],
  "dbinspector.updateData": ["L3", "ویرایش داده", { agent: false, note: "Request body is not described in the spec." }],
  "dbinspector.deleteData": ["L4", "حذف داده", { agent: false, note: "Request body is not described in the spec." }],
  // ---- DNS ----------------------------------------------------------------
  "dns.getListZones": ["L0", "فهرست زون‌ها"],
  "dns.createZone": ["L3", "ساخت زون DNS"],
  "dns.getZone": ["L0", "جزئیات زون"],
  "dns.deleteZone": ["L4", "حذف زون و همه‌ی رکوردها"],
  "dns.checkNameServer": ["L1", "بررسی نیم‌سرورها"],
  "dns.getListDnsRecords": ["L0", "رکوردهای DNS"],
  "dns.createDnsRecord": ["L3", "ساخت رکورد DNS"],
  "dns.getDnsRecord": ["L0", "جزئیات رکورد DNS"],
  "dns.editDnsRecord": ["L3", "ویرایش رکورد DNS", { note: "Record type cannot be changed (per spec)." }],
  "dns.deleteDnsRecord": ["L3", "حذف رکورد DNS"],
  // ---- Object storage -----------------------------------------------------
  "storage.getBuckets": ["L0", "فهرست باکت‌ها"],
  "storage.createBucket": ["L3", "ساخت باکت"],
  "storage.getMigrations": ["L0", "عملیات انتقال باکت", { status: "partial", note: "Live API returns 404 (route is shadowed by /buckets/{bucket}); verified 2026-10-23." }],
  "storage.changeBucketAccess": ["L3", "تغییر دسترسی باکت (عمومی/خصوصی)"],
  "storage.upgradeBucket": ["L3", "ارتقای پلن باکت"],
  "storage.getSingleBuckets": ["L0", "جزئیات باکت"],
  "storage.destroyBucket": ["L4", "حذف باکت"],
  "storage.checkBucket": ["L0", "بررسی آزاد بودن نام باکت"],
  "storage.migratingBuckets": ["L3", "انتقال داده بین باکت‌ها"],
  "storage.getListPreviousBuckets": ["L0", "باکت‌های سرویس قدیمی", { status: "partial", note: "Live API returns 404 for this route; verified 2026-10-23." }],
  "storage.getListKeys": ["L0", "کلیدهای دسترسی", { secretResponse: true }],
  "storage.createKey": ["L2", "ساخت کلید دسترسی", { secretResponse: true }],
  "storage.getKey": ["L0", "جزئیات کلید", { secretResponse: true }],
  "storage.updateKey": ["L2", "ویرایش باکت‌های کلید"],
  "storage.deleteKey": ["L3", "حذف کلید دسترسی"],
  "storage.revokeSecretKey": ["L3", "باطل کردن کلید محرمانه", { secretResponse: true }],
  "storage.downloadObject": ["L1", "لینک موقت دانلود فایل"],
  "storage.uploadObject": ["L1", "لینک موقت آپلود فایل"],
  "storage.getListObjects": ["L0", "فهرست فایل‌ها"],
  "storage.deleteObject": ["L4", "حذف فایل"],
  "storage.getStatObject": ["L0", "مشخصات فایل"],
  "storage.createFolder": ["L1", "ساخت پوشه"],
  "storage.deleteFolder": ["L4", "حذف پوشه"],
  "storage.getMetricsSummary": ["L0", "خلاصه‌ی مصرف باکت"],
  "storage.getHisotricalMetrics": ["L0", "تاریخچه‌ی مصرف باکت"],
  "storage.getMetrics": ["L0", "آمار باکت"],
  // ---- Mail ---------------------------------------------------------------
  "mail.getMails": ["L0", "فهرست میل‌سرورها"],
  "mail.postMails": ["L3", "ساخت میل‌سرور"],
  "mail.getSingleMailServer": ["L0", "جزئیات میل‌سرور"],
  "mail.editMailServer": ["L2", "ویرایش میل‌سرور"],
  "mail.deleteMailServer": ["L4", "حذف میل‌سرور"],
  "mail.getCredential": ["L0", "دسترسی‌های SMTP"],
  "mail.generateCredentials": ["L2", "ساخت دسترسی SMTP", { secretResponse: true }],
  "mail.revokeCredentials": ["L3", "باطل کردن دسترسی SMTP"],
  "mail.getCountMails": ["L0", "تعداد ایمیل‌های ارسالی"],
  "mail.checkMailServerDnsStatus": ["L0", "وضعیت DNS میل‌سرور"],
  "mail.checkDomainAvailable": ["L0", "بررسی دامنه‌ی میل‌سرور"],
  "mail.getAllMailAccounts": ["L0", "حساب‌های ایمیل"],
  "mail.createMailACcount": ["L2", "ساخت حساب ایمیل", { agent: false, note: "Requires a password value; handled outside the model." }],
  "mail.getAllInboundRules": ["L0", "قوانین ورودی"],
  "mail.addInboundRule": ["L2", "افزودن قانون ورودی"],
  "mail.deleteInboundRule": ["L2", "حذف قانون ورودی"],
  "mail.getAllMails": ["L0", "فهرست ایمیل‌ها", { agent: false, note: "Mailbox content is personal data; not sent to the model." }],
  "mail.sendMail": ["L2", "ارسال ایمیل"],
  "mail.getSingleMail": ["L0", "مشاهده‌ی ایمیل", { agent: false }],
  "mail.getListAddressForwarding": ["L0", "آدرس‌های فوروارد"],
  "mail.createAddressForwarding": ["L3", "افزودن فوروارد ایمیل"],
  "mail.checkMailAvailable": ["L0", "بررسی آزاد بودن آدرس ایمیل"],
  "mail.getSingleMailHtml": ["L0", "HTML ایمیل", { agent: false }],
  "mail.getAllAttachments": ["L0", "پیوست‌ها", { agent: false }],
  "mail.getAllEvents": ["L0", "رویدادهای ایمیل"],
  "mail.downloadAttachments": ["L0", "دانلود پیوست", { agent: false }],
  "mail.generateTemporary": ["L1", "لینک موقت HTML ایمیل", { agent: false }],
  "mail.deleteMailAccount": ["L4", "حذف حساب ایمیل"],
  "mail.deleteSmtpCredential": ["L3", "حذف دسترسی SMTP"],
  "mail.deleteExtraEndpoint": ["L2", "حذف آدرس فوروارد"],
  "mail.trashMessage": ["L1", "انتقال ایمیل به سطل زباله", { agent: false }],
  "mail.deleteMessage": ["L4", "حذف دائمی ایمیل", { agent: false }],
  "mail.unfreeze": ["L3", "رفع توقف میل‌سرور"],
  "mail.getMetrics": ["L0", "آمار مصرف میل‌سرور"],
  "mail.getTags": ["L0", "برچسب‌ها"],
  "mail.createTag": ["L1", "ساخت برچسب"],
  "mail.getTagsStats": ["L0", "آمار برچسب‌ها"],
  "mail.getCurrentPlanHistory": ["L0", "تاریخچه‌ی پلن میل‌سرور"],
  "mail.changePlan": ["L3", "تغییر پلن میل‌سرور"],
  "mail.deleteReservation": ["L2", "حذف پلن رزروشده"],
  // ---- File browser (per-resource host) ------------------------------------
  "filebrowser.getList": ["L0", "فهرست فایل‌های دیسک"],
  "filebrowser.search": ["L0", "جستجوی فایل در دیسک"],
  "filebrowser.serve": ["L0", "دریافت فایل از دیسک", { agent: false }],
  "filebrowser.createLink": ["L1", "لینک موقت فایل"],
  "filebrowser.rename": ["L2", "تغییر نام فایل"],
  "filebrowser.create": ["L2", "ساخت فایل یا پوشه"],
  "filebrowser.extract": ["L2", "استخراج فایل فشرده"],
  "filebrowser.upload": ["L2", "آپلود فایل در دیسک", { agent: false }],
  "filebrowser.delete": ["L4", "حذف فایل یا پوشه از دیسک"],
  // ---- IaaS ---------------------------------------------------------------
  "iaas.getVMs": ["L0", "فهرست سرورهای مجازی"],
  "iaas.createVM": ["L3", "ساخت سرور مجازی"],
  "iaas.getVMDetails": ["L0", "جزئیات سرور مجازی", { secretResponse: true }],
  "iaas.deleteVM": ["L4", "حذف سرور مجازی"],
  "iaas.unfreezeVM": ["L3", "رفع توقف سرور مجازی"],
  "iaas.getVMTrafficGraph": ["L0", "نمودار ترافیک سرور"],
  "iaas.getVMTrafficVolume": ["L0", "حجم ترافیک سرور"],
  "iaas.setVMPower": ["L2", "روشن/خاموش کردن سرور مجازی"],
  "iaas.getVMDiskDetails": ["L0", "دیسک‌های سرور مجازی"],
  "iaas.createVMDisk": ["L3", "افزودن دیسک به سرور"],
  "iaas.extendVMDisk": ["L3", "افزایش حجم دیسک سرور"],
  "iaas.DeleteVMDisk": ["L4", "حذف دیسک سرور"],
  "iaas.resetVMNetwork": ["L2", "ریست شبکه‌ی سرور"],
  "iaas.getVMOperations": ["L0", "عملیات‌های سرور"],
  "iaas.resetVMPassword": ["L3", "ریست رمز سرور", { secretResponse: true, note: "New password is never shown to the model." }],
  "iaas.resizeVM": ["L3", "تغییر پلن سرور مجازی"],
  "iaas.getPlans": ["L0", "پلن‌های سرور مجازی"],
  "iaas.getOperatingSystems": ["L0", "سیستم‌عامل‌های موجود"],
  // ---- Billing & account --------------------------------------------------
  "billing.getBilling": ["L0", "موجودی و صورتحساب"],
  "account.getMe": ["L0", "اطلاعات حساب و پلن‌ها", { secretResponse: true }],
  "account.getMeSubscription": ["L0", "اشتراک فعلی"],
  "account.getMeTwoFA": ["L0", "وضعیت ورود دومرحله‌ای"],
  "account.getMeFreeCredit": ["L0", "اعتبار رایگان باقی‌مانده"],
  "account.getMeGitIntegrations": ["L0", "اتصال‌های Git"],
  "account.getMeUTM": ["L0", "اطلاعات کمپین", { agent: false }],
  // ---- Liara AI -----------------------------------------------------------
  "ai_inference.createChatCompletion": ["L0", "پاسخ مدل زبانی", { agent: false, note: "Used only by the LLM Gateway." }],
  "ai_inference.listInferenceModels": ["L0", "مدل‌های قابل استفاده در ورک‌اسپیس"],
  "ai_inference.createEmbedding": ["L0", "ساخت embedding", { agent: false, note: "Used only by the LLM Gateway." }],
  "ai_inference.generateImage": ["L1", "ساخت تصویر", { agent: false, note: "No image model is in the allowed model list." }],
  "ai_inference.editImage": ["L1", "ویرایش تصویر", { agent: false, note: "No image model is in the allowed model list." }],
  "ai_inference.createTranscription": ["L1", "تبدیل صدا به متن", { agent: false, note: "No speech model is in the allowed model list." }],
  "ai_inference.createSpeech": ["L1", "تبدیل متن به صدا", { agent: false, note: "No speech model is in the allowed model list." }],
  "ai_keys.listKeys": ["L0", "کلیدهای API هوش مصنوعی"],
  "ai_keys.createKey": ["L2", "ساخت کلید API هوش مصنوعی", { secretResponse: true }],
  "ai_keys.updateKey": ["L2", "ویرایش کلید API هوش مصنوعی"],
  "ai_keys.deleteKey": ["L3", "حذف کلید API هوش مصنوعی"],
  "ai_logs.listLogs": ["L0", "لاگ درخواست‌های هوش مصنوعی"],
  "ai_logs.getLogDetailsApiKey": ["L0", "جزئیات لاگ هوش مصنوعی", { agent: false }],
  "ai_logs.getLogDetailsPlayground": ["L0", "جزئیات لاگ playground", { agent: false }],
  "ai_models.listModels": ["L0", "کاتالوگ مدل‌ها"],
  "ai_models.getModel": ["L0", "جزئیات مدل"],
  "ai_models.listModelsFiltered": ["L0", "جستجوی مدل‌ها"],
  "ai_playground.playgroundChatCompletion": ["L0", "چت playground", { agent: false }],
  "ai_playground.playgroundImageGeneration": ["L1", "تصویر playground", { agent: false }],
  "ai_playground.playgroundImageEdit": ["L1", "ویرایش تصویر playground", { agent: false }],
  "ai_playground.playgroundListModels": ["L0", "مدل‌های playground", { agent: false }],
  "ai_workspaces.listWorkspaces": ["L0", "ورک‌اسپیس‌های هوش مصنوعی"],
  "ai_workspaces.createWorkspace": ["L3", "ساخت ورک‌اسپیس هوش مصنوعی"],
  "ai_workspaces.checkWorkspaceAvailability": ["L0", "بررسی نام ورک‌اسپیس"],
  "ai_workspaces.getWorkspace": ["L0", "جزئیات ورک‌اسپیس"],
  "ai_workspaces.deleteWorkspace": ["L4", "حذف ورک‌اسپیس"],
  "ai_workspaces.changeProviderPreferences": ["L1", "ترجیح مسیریابی ارائه‌دهنده"],
  "ai_workspaces.resizeWorkspace": ["L3", "تغییر پلن ورک‌اسپیس"],
  "ai_workspaces.unfreezeWorkspace": ["L3", "رفع توقف ورک‌اسپیس"],
  "ai_workspaces.getFreeTokens": ["L0", "توکن رایگان مصرف‌شده"],
  "ai_workspaces.getModelLimits": ["L0", "محدودیت‌های مدل"],
  "ai_workspaces.getWorkspaceActivity": ["L0", "گزارش مصرف هوش مصنوعی"],
};

export interface Capability extends CapabilityView {
  op: GeneratedOperation | null;
  idempotent: boolean;
  secretResponse: boolean;
}

/** Capabilities users ask for that the official API does NOT provide. */
const NON_API: Array<Omit<Capability, "op" | "idempotent" | "secretResponse" | "method" | "endpoint">> = [
  { id: "billing.topUp", service: "billing", name: "wallet top-up", labelFa: "افزایش موجودی کیف پول", status: "unsupported", risk: "L3", sourceUrl: "https://developers.liara.ir/billing/billing/get-current-user-billing-information.md", evidence: "Billing spec exposes only GET /v1/billing.", notes: "User must pay in the Liara console.", exposedToAgent: false },
  { id: "billing.usageHistory", service: "billing", name: "usage history / invoices", labelFa: "ریز مصرف و فاکتورها", status: "unsupported", risk: "L0", sourceUrl: null, evidence: "No usage/invoice endpoint in billing.yaml.", notes: "Runway is estimated from balance and the hourlyPrice of resources returned by PaaS/DBaaS.", exposedToAgent: false },
  { id: "paas.rollback", service: "paas", name: "rollback to previous release", labelFa: "بازگشت به نسخه‌ی قبلی", status: "partial", risk: "L2", sourceUrl: "https://developers.liara.ir/pass/deploy/deploy-releases.md", evidence: "No rollback operation. releasesDeploy accepts a sourceID.", notes: "Implemented by re-releasing a sourceID this agent uploaded earlier; works only if Liara still retains that source.", exposedToAgent: true },
  { id: "paas.deployImage", service: "paas", name: "deploy prebuilt docker image", labelFa: "دپلوی Docker Image آماده", status: "unsupported", risk: "L2", sourceUrl: null, evidence: "releasesDeploy schema has no image field.", notes: "Use `liara deploy --image` from the Liara CLI.", exposedToAgent: false },
  { id: "paas.privateNetwork.create", service: "paas", name: "create private network", labelFa: "ساخت شبکه‌ی خصوصی", status: "unsupported", risk: "L3", sourceUrl: "https://developers.liara.ir/pass/apps/create-a-app.md", evidence: "Only a `network` name can be passed to createApp; no network endpoints.", notes: "Create the network in the console, then the agent can attach new apps to it by name.", exposedToAgent: false },
  { id: "paas.logs.download", service: "paas", name: "log export", labelFa: "دانلود فایل لاگ", status: "unsupported", risk: "L0", sourceUrl: null, evidence: "getAppLogs returns JSON lines only.", notes: "The UI can copy the filtered lines.", exposedToAgent: false },
  { id: "paas.planPrices", service: "paas", name: "plan catalogue with prices", labelFa: "فهرست پلن‌ها و قیمت", status: "partial", risk: "L0", sourceUrl: "https://developers.liara.ir/account/user/get-current-user-and-console-information.md", evidence: "GET /v1/me returns plans.projects / plans.databases as untyped objects.", notes: "Parsed defensively; fields not present are shown as unknown.", exposedToAgent: true },
  { id: "domain.registrar", service: "dns", name: "registrar operations", labelFa: "خرید دامنه / تغییر نیم‌سرور در ثبت‌کننده", status: "unsupported", risk: "L3", sourceUrl: null, evidence: "Not part of any Liara API.", notes: "Agent gives manual steps, then verifies with dns.checkNameServer / paas.checkDomain.", exposedToAgent: false },
  { id: "dbaas.restore", service: "dbaas", name: "restore database backup", labelFa: "بازگردانی بکاپ دیتابیس", status: "unsupported", risk: "L4", sourceUrl: null, evidence: "dbaas.yaml has backup create/list/download only.", notes: "Download the backup and restore manually.", exposedToAgent: false },
  { id: "ssl.autoRenew", service: "paas", name: "SSL auto-renew toggle", labelFa: "تمدید خودکار SSL", status: "unsupported", risk: "L2", sourceUrl: null, evidence: "Only provision/disable SSL endpoints exist.", notes: "Agent can re-run provision-ssl-certs; certificate expiry is checked over TLS.", exposedToAgent: false },
];

function statusFor(op: GeneratedOperation, env: { fileBrowserUrl: string | null; dbInspectorUrl: string | null }): { status: CapabilityStatus; note: string | null } {
  if (op.baseUrl === "env:LIARA_FILEBROWSER_URL" && !env.fileBrowserUrl)
    return { status: "partial", note: "Spec publishes a templated host ({filebrowser-url}); set LIARA_FILEBROWSER_URL to enable." };
  if (op.baseUrl === "env:LIARA_DB_INSPECTOR_URL" && !env.dbInspectorUrl)
    return { status: "partial", note: "Spec publishes a templated host ({database-inspector-url}); set LIARA_DB_INSPECTOR_URL to enable." };
  if (op.body && op.body.required && JSON.stringify(op.body.schema) === "{}") return { status: "partial", note: "Request body schema is empty in the spec." };
  return { status: "supported", note: null };
}

export class CapabilityRegistry {
  private map = new Map<string, Capability>();

  constructor(env: { fileBrowserUrl: string | null; dbInspectorUrl: string | null }) {
    for (const op of GENERATED_OPERATIONS) {
      const meta = META[op.id];
      const [risk, labelFa, opts] = meta ?? (["L4", op.summary, { agent: false, note: "No risk review yet; blocked for the agent." }] as Meta);
      const st = statusFor(op, env);
      const notes = [opts?.note, st.note].filter(Boolean).join(" ") || null;
      this.map.set(op.id, {
        id: op.id,
        service: op.service,
        name: op.operationId,
        labelFa,
        status: meta ? (opts?.status ?? st.status) : "unknown",
        risk,
        method: op.method,
        endpoint: op.path,
        sourceUrl: `https://developers.liara.ir/spec/${op.specFile}`,
        evidence: `${op.specFile} operationId=${op.operationId}`,
        notes,
        exposedToAgent: opts?.agent ?? true,
        op,
        idempotent: opts?.idempotent ?? (op.method === "GET" || op.method === "PUT"),
        secretResponse: opts?.secretResponse ?? false,
      });
    }
    for (const c of NON_API) this.map.set(c.id, { ...c, method: null, endpoint: null, op: null, idempotent: false, secretResponse: false });
  }

  get(id: string): Capability | undefined {
    return this.map.get(id);
  }

  require(id: string): Capability {
    const c = this.map.get(id);
    if (!c) throw new Error(`unknown capability ${id}`);
    return c;
  }

  list(): Capability[] {
    return [...this.map.values()];
  }

  views(): CapabilityView[] {
    return this.list().map(({ op: _op, idempotent: _i, secretResponse: _s, ...v }) => v);
  }

  /** True when the capability exists in the verified inventory and can be executed. */
  isExecutable(id: string): boolean {
    const c = this.map.get(id);
    return !!c && !!c.op && (c.status === "supported" || (c.status === "partial" && !c.op.baseUrl.startsWith("env:")));
  }
}

export const REVIEWED_OPERATION_IDS = Object.keys(META);
