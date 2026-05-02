// Minimal navigation: رفع التقارير — صفحتان فقط.
const valueSystemGroups = {
  uploadReports: {
    id: "uploadReports",
    title: "Upload Reports",
    titleAr: "رفع التقارير",
    tabs: [
      {
        id: "upload-report-elrajhi",
        label: "Upload Report (El Rajhi)",
        labelAr: "رفع تقارير (الراجحي)",
        description: "Upload El Rajhi reports and process batches.",
      },
      {
        id: "submit-reports-quickly",
        label: "Submit Reports Quickly",
        labelAr: "رفع سريع",
        description: "Quickly submit reports using Excel sheets.",
      },
    ],
  },
};

const valueSystemCards = [
  {
    id: "uploading-reports",
    title: "Uploading Reports",
    titleAr: "رفع التقارير",
    description: "Upload and manage valuation reports.",
    groups: ["uploadReports"],
    defaultGroup: "uploadReports",
  },
];

const viewTitles = {
  "upload-report-elrajhi": "Upload Report (El Rajhi)",
  "submit-reports-quickly": "Submit Reports Quickly",
  "system-settings": "Settings",
};

const allValueSystemViews = valueSystemGroups.uploadReports.tabs.map((t) => t.id);

/** أول تاب في مجموعة رفع التقارير — الصفحة الافتراضية عند فتح التطبيق */
const DEFAULT_HOME_VIEW = valueSystemGroups.uploadReports.tabs[0]?.id || "upload-report-elrajhi";

const isValueSystemView = (viewId) => allValueSystemViews.includes(viewId);

const tabToGroup = allValueSystemViews.reduce((acc, tabId) => {
  acc[tabId] = "uploadReports";
  return acc;
}, {});

const findTabInfo = (tabId) => {
  if (tabId === "system-settings") {
    return {
      groupId: null,
      groupTitle: "Settings",
      tab: {
        id: "system-settings",
        label: "Settings",
        labelAr: "الإعدادات",
        description: "Workspace preferences, stats, and system tools.",
        descriptionAr: "تفضيلات مساحة العمل والإحصائيات وأدوات النظام.",
      },
    };
  }
  const group = valueSystemGroups.uploadReports;
  const tab = group.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  return { groupId: group.id, groupTitle: group.title, tab };
};

module.exports = {
  valueSystemGroups,
  valueSystemCards,
  viewTitles,
  allValueSystemViews,
  DEFAULT_HOME_VIEW,
  isValueSystemView,
  tabToGroup,
  findTabInfo,
};
