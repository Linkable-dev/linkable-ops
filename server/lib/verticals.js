// The verticals a brand can be classified into. The pipeline decides which one
// (linkable-prospector/src/prospector/verticals.py); this list must name the
// same codes, which are also the product's creator niches.
export const VERTICALS = {
  BEAUTY_SKINCARE: "Beauty & skincare",
  FASHION_ACCESSORIES: "Fashion & accessories",
  HEALTH_WELLNESS: "Health & wellness",
  FITNESS_SPORTS: "Fitness & sports",
  FOOD_BEVERAGE: "Food & drink",
  HOME_LIVING: "Home & living",
  BABY_PARENTING: "Baby & parenting",
  PETS: "Pets",
  TRAVEL: "Travel",
  TECHNOLOGY: "Tech & gadgets",
};
// A brand the pipeline could not classify.
export const NO_VERTICAL = "NONE";
