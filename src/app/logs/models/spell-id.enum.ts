export const PSEUDO_SPELL_BASE = 10000000;

export enum SpellId {
  NONE = 0,

  // Feral Druid Abilities (Max Rank)
  CAT_FORM = 768,
  DIRE_BEAR_FORM = 9634,
  RAKE = 48574,
  RIP = 49800,
  SHRED = 48572,
  LACERATE = 48568,
  MANGLE_CAT = 48566,
  MANGLE_BEAR = 48564,
  MAUL = 48480,
  GOTW = 48470,
  BITE = 48577,
  ROAR = 52610,
  TIGERS_FURY = 50213,
  ENRAGE = 5229,
  FERAL_BERSERK = 50334,
  INNERVATE = 29166,
  REBIRTH = 48477,
  NATURES_GRASP = 53312,
  FAERIE_FIRE_FERAL = 16857,
  FAERIE_FIRE_FERAL_DMG = 60089,
  FAERIE_FIRE = 770,
  SWIPE_CAT = 62078,
  SWIPE_BEAR = 48562,
  POUNCE = 49803,
  POUNCE_BLEED = 49804,
  MAIM = 49802,
  RAVAGE = 48579,
  WRATH = 48461,
  STARFIRE = 48465,
  MOONFIRE = 48463,


  // Shadow Priest Abilities (Max Rank)
  BERSERKING = 26297,
  // DEATH = 48158,
  // DEVOURING_PLAGUE = 48300,
  // DISPERSION = 47585,
  // DIVINE_HYMN = 64843,
  // FADE = 586,
  // FEAR_WARD = 6346,
  // HOLY_NOVA = 48078,
  // HYMN_OF_HOPE = 64901,
  // MIND_BLAST = 48127,
  // MIND_FLAY = 48156,
  // MIND_SEAR = 53023,
  // PAIN = 48125,
  // SHADOW_FIEND = 34433,
  // SHIELD = 48066,
  // VAMPIRIC_EMBRACE = 15286,
  // VAMPIRIC_TOUCH = 48160,
  // DISPEL_MAGIC = 988,
  // MASS_DISPEL = 32375,

  // Related damage IDs
  IMPROVED_DEVOURING_PLAGUE = 63675,
  MIND_FLAY_TICK = 58381,
  MIND_SEAR_TICK = 53022,

  // Engineering
  ADAMANTITE_GRENADE = 30217,
  DENSE_DYNAMITE = 23063,
  FEL_IRON_BOMB = 30216,
  GOBLIN_LAND_MINE = 4100,
  GOBLIN_SAPPER = 13241,
  SUPER_SAPPER = 30486,

  // Pseudo spell IDs (map to WCL negative values)
  // MELEE = PSEUDO_SPELL_BASE + 32

  MELEE = 1
}

// Map WCL ability IDS (ability.guid) to a local spell ID
// Mostly here now to allow processing of shadowfiend melee
export function mapSpellId(guid: number) {
  if (guid > 0) {
    return guid;
  }

  return PSEUDO_SPELL_BASE + Math.abs(guid);
}
