export const PLATFORMS: Record<string, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  google: "Google Ads",
};

export const OBJECTIVES: Record<string, string> = {
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_LEADS: "Leads",
  OUTCOME_SALES: "Sales",
  OUTCOME_APP_PROMOTION: "App promotion",
};

export const NOT_REPORTED_GOAL = "Unknown Optimization Goal";

const GOALS: Record<string, string> = {
  [NOT_REPORTED_GOAL]: "Not reported",
  REACH: "Reach",
  IMPRESSIONS: "Impressions",
  THRUPLAY: "ThruPlay",
  AD_RECALL_LIFT: "Ad recall lift",
  TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: "2-second video views",
  LINK_CLICKS: "Link clicks",
  LANDING_PAGE_VIEWS: "Landing page views",
  PROFILE_VISIT: "Profile visits",
  POST_ENGAGEMENT: "Post engagement",
  PAGE_LIKES: "Page likes",
  CONVERSATIONS: "Conversations",
  LEAD_GENERATION: "Leads (instant forms)",
  QUALITY_LEAD: "Quality leads",
  OFFSITE_CONVERSIONS: "Conversions",
  VALUE: "Value",
  RETURN_ON_AD_SPEND: "ROAS goal",
  APP_INSTALLS: "App installs",
};

export const MARKETS: Record<string, string> = {
  SG: "Singapore", MY: "Malaysia", ID: "Indonesia", PH: "Philippines", TH: "Thailand",
  VN: "Vietnam", JP: "Japan", KR: "Korea", TW: "Taiwan", HK: "Hong Kong",
};

const titleCase = (raw: string) =>
  raw.replace(/^OUTCOME_/, "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const objectiveLabel = (raw: string) => OBJECTIVES[raw] ?? titleCase(raw);
export const goalLabel = (raw: string) => GOALS[raw] ?? titleCase(raw);
export const platformLabel = (raw: string) => PLATFORMS[raw] ?? raw;
export const marketLabel = (raw: string) => MARKETS[raw] ?? raw;
