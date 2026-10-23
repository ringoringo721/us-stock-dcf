(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IndustryTaxonomy = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const INDUSTRY_NAMES_ZH = {
    "Advertising Agencies": "廣告代理",
    "Aerospace & Defense": "航太與國防",
    "Agricultural & Farm Machinery": "農業與農用機械",
    "Agricultural - Commodities/Milling": "農業 — 大宗商品／碾磨",
    "Agricultural - Machinery": "農業 — 機械",
    "Agricultural Farm Products": "農業農產品",
    "Agricultural Inputs": "農業投入品",
    "Agricultural Products & Services": "農產品與農業服務",
    "Air Freight & Logistics": "航空貨運與物流",
    "Airlines, Airports & Air Services": "航空、機場與航空服務",
    "Airport Services": "機場營運與服務",
    "Alternative Carriers": "替代電信運營商",
    "Aluminum": "鋁業",
    "Apparel - Footwear & Accessories": "服裝 — 鞋類與配件",
    "Apparel - Manufacturers": "服裝 — 製造商",
    "Apparel - Retail": "服裝 — 零售",
    "Apparel Retail": "服裝零售",
    "Apparel, Accessories & Luxury Goods": "服裝、配件與奢侈品",
    "Application Software": "應用軟體",
    "Asset Management": "資產管理",
    "Asset Management & Custody Banks": "資產管理與託管銀行",
    "Auto - Dealerships": "汽車 — 經銷商",
    "Auto - Manufacturers": "汽車 — 製造商",
    "Auto - Parts": "汽車 — 零件",
    "Auto - Recreational Vehicles": "汽車 — 休旅車",
    "Automobile Manufacturers": "汽車製造商",
    "Automotive Parts & Equipment": "汽車零件與設備",
    "Automotive Retail": "汽車零售與配件",
    "Banks": "銀行",
    "Banks - Diversified": "銀行 — 多元化",
    "Banks - Regional": "銀行 — 地區性",
    "Beverages - Alcoholic": "飲料 — 酒精",
    "Beverages - Non-Alcoholic": "飲料 — 非酒精",
    "Beverages - Wineries & Distilleries": "飲料 — 酒莊與蒸餾",
    "Biotechnology": "生物科技",
    "Brewers": "啤酒釀造",
    "Broadcasting": "廣播傳媒",
    "Broadline Retail": "綜合零售與電商",
    "Building Products": "建築建材與設備",
    "Business Equipment & Supplies": "商務設備與用品",
    "Cable & Satellite": "有線電視與衛星",
    "Casinos & Gaming": "博彩與賭場娛樂",
    "Chemicals": "化學品",
    "Chemicals - Specialty": "化學品 — 特種",
    "Coal": "煤炭",
    "Coal & Consumable Fuels": "煤炭與消耗性燃料",
    "Commercial & Professional Services": "商業與專業服務",
    "Commodity Chemicals": "大宗商品化學品",
    "Communication Equipment": "通訊設備",
    "Communications Equipment": "通訊設備與器材",
    "Computer Hardware": "電腦硬體",
    "Conglomerates": "綜合企業集團",
    "Construction": "建築營造",
    "Construction Machinery & Heavy Transportation Equipment": "工程機械與重型運輸",
    "Construction Materials": "建築骨料與水泥材料",
    "Consulting Services": "顧問服務",
    "Consumer Electronics": "消費性電子",
    "Consumer Finance": "消費金融與信用卡",
    "Consumer Staples Merchandise Retail": "必需品與大賣場零售",
    "Copper": "銅礦開採與冶煉",
    "Data Center REITs": "數據中心房地產信託",
    "Data Processing & Outsourced Services": "數據處理與外包服務",
    "Department Stores": "百貨公司",
    "Discount Stores": "折扣量販店",
    "Diversified Banks": "多元化大型銀行",
    "Diversified Metals & Mining": "多元金屬與採礦",
    "Diversified Support Services": "多元化支援服務",
    "Diversified Utilities": "多元化公用事業",
    "Drug Manufacturers - General": "藥廠 — 綜合大型",
    "Drug Manufacturers - Specialty & Generic": "藥廠 — 專科與學名藥",
    "Education & Training Services": "教育與培訓服務",
    "Education Services": "教育服務",
    "Electric Utilities": "電力公用事業",
    "Electrical Components & Equipment": "電氣零件與工業設備",
    "Electrical Equipment & Parts": "電氣設備與零件",
    "Electronic Components": "電子元件與連接器",
    "Electronic Equipment & Instruments": "電子儀器與測量設備",
    "Electronic Gaming & Multimedia": "電子遊戲與多媒體",
    "Electronic Manufacturing Services": "電子製造服務",
    "Engineering & Construction": "工程與建築",
    "Entertainment": "娛樂",
    "Environmental & Facilities Services": "環保廢品與設施服務",
    "Fertilizers & Agricultural Chemicals": "肥料與農用化學品",
    "Financial - Capital Markets": "金融 — 資本市場",
    "Financial - Conglomerates": "金融 — 綜合集團",
    "Financial - Credit Services": "金融 — 信用服務",
    "Financial - Data & Stock Exchanges": "金融 — 數據與證券交易所",
    "Financial - Mortgages": "金融 — 抵押貸款",
    "Financial Exchanges & Data": "金融交易所與財經數據",
    "Food Confectioners": "糖果點心食品",
    "Food Distribution": "食品分銷",
    "Footwear": "運動鞋類製造",
    "Furnishings, Fixtures & Appliances": "家具、裝潢與家電",
    "Gambling, Resorts & Casinos": "博彩、度假村與賭場",
    "Gas Utilities": "燃氣公用事業",
    "General Transportation": "綜合運輸",
    "Gold": "黃金採掘與貴金屬",
    "Grocery Stores": "超市與雜貨零售",
    "Hardware, Equipment & Parts": "硬體、設備與零件",
    "Health Care Distributors": "醫藥分銷與物流",
    "Health Care Equipment": "醫療設備與器材",
    "Health Care Services": "醫療照護與透析服務",
    "Health Care Supplies": "醫療耗材與隱適美",
    "Health Care Technology": "醫療科技與雲端系統",
    "Home Improvement": "家居修繕",
    "Home Improvement Retail": "家裝零售與家居改善",
    "Hotel & Resort REITs": "酒店與博彩房地產信託",
    "Hotels & Gaming-related Assets": "酒店與博彩相關資產",
    "Hotels, Resorts & Cruise Lines": "酒店、度假村與郵輪",
    "Household & Personal Products": "家庭與個人用品",
    "Household Appliances": "家用電器",
    "Household Products": "家庭與日用消費品",
    "Human Resource & Employment Services": "人力資源與薪酬管理",
    "IT Consulting & Other Services": "資訊技術諮詢與服務",
    "Independent Power Producers": "獨立發電業者",
    "Independent Power Producers & Energy Traders": "獨立發電與能源交易",
    "Industrial - Distribution": "工業 — 分銷",
    "Industrial - Infrastructure Operations": "工業 — 基礎設施營運",
    "Industrial - Machinery": "工業 — 機械",
    "Industrial - Pollution & Treatment Controls": "工業 — 污染與處理控制",
    "Industrial - Specialties": "工業 — 特種",
    "Industrial Conglomerates": "工業綜合控股集團",
    "Industrial Gases": "工業氣體製造",
    "Industrial Machinery": "工業機械與設備製造",
    "Industrial Machinery & Supplies & Components": "工業機械、用品與零件",
    "Industrial Materials": "工業材料",
    "Industrial REITs": "工業與倉儲物流信託",
    "Information Technology Services": "資訊科技服務",
    "Insurance - Brokers": "保險 — 經紀",
    "Insurance - Diversified": "保險 — 多元化",
    "Insurance - Life": "保險 — 人壽",
    "Insurance - Property & Casualty": "保險 — 產險",
    "Insurance - Reinsurance": "保險 — 再保險",
    "Insurance - Specialty": "保險 — 專科",
    "Insurance Brokers": "保險經紀與風險諮詢",
    "Integrated Freight & Logistics": "整合貨運與物流",
    "Integrated Oil & Gas": "整合型綜合油氣巨頭",
    "Integrated Telecommunication Services": "綜合電信運營服務",
    "Interactive Home Entertainment": "互動家用娛樂與主機遊戲",
    "Interactive Media & Services": "互動媒體與互聯網服務",
    "Internet Content & Information": "網路內容與資訊",
    "Investment - Banking & Investment Services": "投資 — 投行與投資服務",
    "Investment Banking & Brokerage": "投資銀行與證券經紀",
    "Leisure": "休閒",
    "Leisure Products": "休閒產品",
    "Life & Health Insurance": "人壽與健康保險",
    "Life Sciences Tools & Services": "生命科學工具與實驗室服務",
    "Lottery & Digital Financial Services": "彩票與數字金融服務",
    "Luxury Goods": "奢侈品",
    "Managed Healthcare": "健康管理與醫療保險",
    "Manufacturing - Metal Fabrication": "製造 — 金屬加工",
    "Manufacturing - Miscellaneous": "製造 — 其他",
    "Manufacturing - Textiles": "製造 — 紡織",
    "Manufacturing - Tools & Accessories": "製造 — 工具與配件",
    "Marine Shipping": "海運航運",
    "Marine Transportation": "海運",
    "Media & Entertainment": "媒體與娛樂",
    "Medical - Care Facilities": "醫療 — 照護機構",
    "Medical - Devices": "醫療 — 器材設備",
    "Medical - Diagnostics & Research": "醫療 — 診斷與研究",
    "Medical - Distribution": "醫療 — 分銷",
    "Medical - Healthcare Information Services": "醫療 — 健康資訊服務",
    "Medical - Healthcare Plans": "醫療 — 健康保險計畫",
    "Medical - Instruments & Supplies": "醫療 — 儀器與耗材",
    "Medical - Pharmaceuticals": "醫療 — 製藥",
    "Medical - Specialties": "醫療 — 專科",
    "Movies & Entertainment": "電影、影視與娛樂傳媒",
    "Multi-Sector Holdings": "多元化板塊控股 (如波克夏)",
    "Multi-Utilities": "綜合公用事業",
    "Multi-line Insurance": "綜合保險集團",
    "Oil & Gas Drilling": "油氣鑽探",
    "Oil & Gas Equipment & Services": "油氣設備與油田工程服務",
    "Oil & Gas Exploration & Production": "油氣勘探與採掘 (E&P)",
    "Oil & Gas Integrated": "整合型油氣",
    "Oil & Gas Midstream": "油氣中游",
    "Oil & Gas Refining & Marketing": "石油煉化與加油站營銷",
    "Oil & Gas Storage & Transportation": "油氣儲運與中游管線",
    "Other Precious Metals": "其他貴金屬",
    "Other Specialty Retail": "其他專業零售",
    "Packaged Foods": "包裝食品",
    "Packaged Foods & Meats": "包裝食品與休閒零食",
    "Packaging & Containers": "包裝與容器",
    "Paper, Lumber & Forest Products": "紙漿、木材與林產品",
    "Personal Products & Services": "個人用品與服務",
    "Personal Services": "個人與殯葬禮儀服務",
    "Pharmaceuticals": "大型傳統製藥",
    "Property & Casualty Insurance": "財產與意外傷害險",
    "Publishing": "出版",
    "REIT - Diversified": "房地產信託 — 多元化",
    "REIT - Healthcare Facilities": "房地產信託 — 醫療設施",
    "REIT - Hotel & Motel": "房地產信託 — 旅館",
    "REIT - Industrial": "房地產信託 — 工業",
    "REIT - Mortgage": "房地產信託 — 抵押型",
    "REIT - Office": "房地產信託 — 辦公",
    "REIT - Residential": "房地產信託 — 住宅",
    "REIT - Retail": "房地產信託 — 零售",
    "REIT - Specialty": "房地產信託 — 特種",
    "Rail Transportation": "鐵路重載貨運物流",
    "Railroads": "鐵路",
    "Real Estate - Development": "房地產 — 開發",
    "Real Estate - Diversified": "房地產 — 多元化",
    "Real Estate - Services": "房地產 — 服務",
    "Real Estate Development": "房地產開發",
    "Real Estate Operating Companies": "房地產經營公司",
    "Real Estate Services": "房地產專業服務與資訊",
    "Regulated Electric": "受管制電力",
    "Regulated Gas": "受管制燃氣",
    "Regulated Water": "受管制水務",
    "Renewable Utilities": "再生能源公用事業",
    "Rental & Leasing Services": "租賃服務",
    "Research & Consulting Services": "徵信調查與諮詢服務",
    "Residential Construction": "住宅營建",
    "Restaurants": "連鎖餐飲與快餐咖啡",
    "Retail REITs": "零售與購物中心信託",
    "Security & Protection Services": "保全與防護服務",
    "Semiconductor Materials & Equipment": "半導體材料與晶圓設備",
    "Semiconductors": "半導體設計與晶圓製造",
    "Soft Drinks & Non-alcoholic Beverages": "軟性飲料與無酒精飲品",
    "Software - Application": "軟體 — 應用",
    "Software - Infrastructure": "軟體 — 基礎架構",
    "Software - Services": "軟體 — 服務",
    "Solar": "太陽能",
    "Specialty Business Services": "專業商業服務",
    "Specialty Chemicals": "特種精細化學品",
    "Specialty Retail": "專業零售",
    "Specialty Stores": "專業農牧零售店",
    "Staffing & Employment Services": "人力派遣與就業服務",
    "Steel": "鋼鐵",
    "Systems Software": "系統基礎架構與資安軟體",
    "Technology Distributors": "科技產品分銷",
    "Technology Hardware, Storage & Peripherals": "消費硬體與存儲周邊",
    "Telecom Tower REITs": "通訊基地台房產信託",
    "Telecommunications Services": "電信服務",
    "Textiles": "紡織品",
    "Tobacco": "菸草與新型無煙產品",
    "Transaction & Payment Processing Services": "交易清算與支付網絡",
    "Travel Lodging": "旅宿",
    "Travel Services": "旅遊服務",
    "Trucking": "公路貨運",
    "Unclassified": "未分類",
    "Uranium": "鈾礦",
    "Waste Management": "廢棄物管理",
    "Water Utilities": "水務公用事業",
    "Wireless Telecommunication Services": "無線蜂窩行動通訊"
  };

  const PARENT_NAMES_ZH = {
    "Agricultural": "農業",
    "Apparel": "服裝",
    "Auto": "汽車",
    "Banks": "銀行",
    "Beverages": "飲料",
    "Chemicals": "化學品",
    "Drug Manufacturers": "藥廠",
    "Financial": "金融",
    "Industrial": "工業",
    "Insurance": "保險",
    "Investment": "投資",
    "Manufacturing": "製造",
    "Medical": "醫療",
    "Oil & Gas": "油氣",
    "REIT": "房地產信託",
    "Real Estate": "房地產",
    "Software": "軟體"
  };

  // Fold baseline GICS labels into the same parents as FMP "Parent - Sub" strings.
  const PARENT_ALIASES = {
    "Agricultural & Farm Machinery": { parent: "Agricultural", sub: "Machinery" },
    "Agricultural Farm Products": { parent: "Agricultural", sub: "Farm Products" },
    "Agricultural Inputs": { parent: "Agricultural", sub: "Inputs" },
    "Agricultural Products & Services": { parent: "Agricultural", sub: "Products & Services" },
    "Apparel Retail": { parent: "Apparel", sub: "Retail" },
    "Apparel, Accessories & Luxury Goods": { parent: "Apparel", sub: "Accessories & Luxury Goods" },
    "Application Software": { parent: "Software", sub: "Application" },
    "Automobile Manufacturers": { parent: "Auto", sub: "Manufacturers" },
    "Automotive Parts & Equipment": { parent: "Auto", sub: "Parts" },
    "Automotive Retail": { parent: "Auto", sub: "Retail" },
    "Biotechnology": { parent: "Medical", sub: "Biotechnology" },
    "Commodity Chemicals": { parent: "Chemicals", sub: "Commodity" },
    "Communications Equipment": { parent: "Communication Equipment", sub: null },
    "Data Center REITs": { parent: "REIT", sub: "Specialty" },
    "Diversified Banks": { parent: "Banks", sub: "Diversified" },
    "Fertilizers & Agricultural Chemicals": { parent: "Agricultural", sub: "Inputs" },
    "Footwear": { parent: "Apparel", sub: "Footwear" },
    "Health Care Distributors": { parent: "Medical", sub: "Distribution" },
    "Health Care Equipment": { parent: "Medical", sub: "Devices" },
    "Health Care Services": { parent: "Medical", sub: "Care Facilities" },
    "Health Care Supplies": { parent: "Medical", sub: "Instruments & Supplies" },
    "Health Care Technology": { parent: "Medical", sub: "Healthcare Information Services" },
    "Hotel & Resort REITs": { parent: "REIT", sub: "Hotel & Motel" },
    "Industrial Machinery": { parent: "Industrial", sub: "Machinery" },
    "Industrial Machinery & Supplies & Components": { parent: "Industrial", sub: "Machinery" },
    "Industrial REITs": { parent: "REIT", sub: "Industrial" },
    "Insurance Brokers": { parent: "Insurance", sub: "Brokers" },
    "Integrated Oil & Gas": { parent: "Oil & Gas", sub: "Integrated" },
    "Investment Banking & Brokerage": { parent: "Investment", sub: "Banking & Investment Services" },
    "Life & Health Insurance": { parent: "Insurance", sub: "Life" },
    "Life Sciences Tools & Services": { parent: "Medical", sub: "Diagnostics & Research" },
    "Managed Healthcare": { parent: "Medical", sub: "Healthcare Plans" },
    "Multi-line Insurance": { parent: "Insurance", sub: "Diversified" },
    "Oil & Gas Drilling": { parent: "Oil & Gas", sub: "Drilling" },
    "Oil & Gas Equipment & Services": { parent: "Oil & Gas", sub: "Equipment & Services" },
    "Oil & Gas Exploration & Production": { parent: "Oil & Gas", sub: "Exploration & Production" },
    "Oil & Gas Integrated": { parent: "Oil & Gas", sub: "Integrated" },
    "Oil & Gas Midstream": { parent: "Oil & Gas", sub: "Midstream" },
    "Oil & Gas Refining & Marketing": { parent: "Oil & Gas", sub: "Refining & Marketing" },
    "Oil & Gas Storage & Transportation": { parent: "Oil & Gas", sub: "Storage & Transportation" },
    "Pharmaceuticals": { parent: "Medical", sub: "Pharmaceuticals" },
    "Property & Casualty Insurance": { parent: "Insurance", sub: "Property & Casualty" },
    "Real Estate Development": { parent: "Real Estate", sub: "Development" },
    "Real Estate Operating Companies": { parent: "Real Estate", sub: "Operating Companies" },
    "Real Estate Services": { parent: "Real Estate", sub: "Services" },
    "Retail REITs": { parent: "REIT", sub: "Retail" },
    "Specialty Chemicals": { parent: "Chemicals", sub: "Specialty" },
    "Systems Software": { parent: "Software", sub: "Infrastructure" },
    "Telecom Tower REITs": { parent: "REIT", sub: "Specialty" }
  };

  const SECTOR_CANONICAL = {
    "Basic Materials": "原物料",
    "Communication Services": "通訊服務",
    "Consumer Cyclical": "非必需消費",
    "Consumer Defensive": "必需消費",
    "Consumer Discretionary": "非必需消費",
    "Consumer Staples": "必需消費",
    "Energy": "能源",
    "Financial Services": "金融",
    "Financials": "金融",
    "Health Care": "醫療保健",
    "Healthcare": "醫療保健",
    "Industrials": "工業",
    "Information Technology": "資訊科技",
    "Materials": "原物料",
    "Real Estate": "房地產",
    "Technology": "資訊科技",
    "Utilities": "公用事業",
    "公用事業": "公用事業",
    "原物料": "原物料",
    "工業": "工業",
    "必需消費": "必需消費",
    "房地產": "房地產",
    "能源": "能源",
    "資訊科技": "資訊科技",
    "通訊服務": "通訊服務",
    "醫療保健": "醫療保健",
    "金融": "金融",
    "非必需消費": "非必需消費"
  };

  function canonicalSector(sector) {
    if (!sector) return sector;
    return SECTOR_CANONICAL[sector] || sector;
  }

  function parse(industry) {
    const full = String(industry || '').trim() || 'Unclassified';
    const alias = PARENT_ALIASES[full];
    if (alias) {
      return { parent: alias.parent, sub: alias.sub, full };
    }
    const dash = full.indexOf(' - ');
    if (dash > 0) {
      return {
        parent: full.slice(0, dash).trim(),
        sub: full.slice(dash + 3).trim(),
        full
      };
    }
    if (full.startsWith('Oil & Gas ')) {
      return { parent: 'Oil & Gas', sub: full.slice('Oil & Gas '.length).trim(), full };
    }
    return { parent: full, sub: null, full };
  }

  function labelIndustry(industry, lang) {
    const full = String(industry || '').trim();
    if (!full || full === 'ALL') return full;
    if (lang === 'zh') return INDUSTRY_NAMES_ZH[full] || full;
    return full;
  }

  function labelParent(parent, lang) {
    const key = String(parent || '').trim();
    if (!key || key === 'ALL') return key;
    if (lang === 'zh') {
      return PARENT_NAMES_ZH[key] || INDUSTRY_NAMES_ZH[key] || key;
    }
    return key;
  }

  // Chip / filter identity within a parent: aliases that share parent+sub collapse together.
  function canonicalSubKey(parts) {
    if (!parts) return '';
    return parts.sub == null ? '' : String(parts.sub);
  }

  // Prefer FMP "Parent - Sub" rows when choosing a label for a merged chip group.
  function preferParts(existing, next) {
    if (!existing) return next;
    if (!next) return existing;
    const existingDash = existing.full.includes(' - ');
    const nextDash = next.full.includes(' - ');
    if (nextDash && !existingDash) return next;
    return existing;
  }

  function labelSub(parts, lang) {
    if (!parts) return '';
    if (lang === 'zh') {
      const fullZh = INDUSTRY_NAMES_ZH[parts.full];
      if (fullZh && parts.sub) {
        const cut = fullZh.indexOf(' — ');
        if (cut > 0) return fullZh.slice(cut + 3);
      }
      if (fullZh) return fullZh;
      if (parts.sub) return parts.sub;
      return parts.full;
    }
    return parts.sub || parts.full;
  }

  function matches(industry, parentFilter, subFilter) {
    const parts = parse(industry);
    if (parentFilter && parentFilter !== 'ALL' && parts.parent !== parentFilter) return false;
    if (subFilter && subFilter !== 'ALL' && canonicalSubKey(parts) !== subFilter) return false;
    return true;
  }

  return {
    INDUSTRY_NAMES_ZH,
    PARENT_NAMES_ZH,
    PARENT_ALIASES,
    SECTOR_CANONICAL,
    canonicalSector,
    parse,
    canonicalSubKey,
    preferParts,
    labelIndustry,
    labelParent,
    labelSub,
    matches
  };
});
