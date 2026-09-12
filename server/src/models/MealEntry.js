import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Macros are denormalised onto the entry on purpose.
 *
 * A log is a historical record of what the user ate. If foods.json is ever
 * corrected, yesterday's logged calories should not silently change — so the
 * numbers are computed from the catalogue at write time and then frozen here,
 * alongside the catalogue id that produced them.
 */
const MacroSchema = new Schema(
  {
    calories: { type: Number, required: true },
    protein: { type: Number, required: true },
    carbs: { type: Number, required: true },
    fat: { type: Number, required: true },
  },
  { _id: false },
);

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

const MealEntrySchema = new Schema(
  {
    userId: { type: String, required: true, default: 'demo-user', index: true },
    foodId: { type: String, required: true },
    foodName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0.01 },
    unit: { type: String, required: true },
    grams: { type: Number, required: true, min: 0.01 },
    macros: { type: MacroSchema, required: true },
    mealType: { type: String, enum: MEAL_TYPES, required: true },
    loggedAt: { type: Date, required: true },
    /** The user's own words, kept so the page can show what was actually said. */
    spokenAs: { type: String, default: '' },
    source: { type: String, enum: ['voice', 'api'], default: 'api' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        return ret;
      },
    },
  },
);

MealEntrySchema.index({ userId: 1, loggedAt: -1 });

export const MealEntry = mongoose.model('MealEntry', MealEntrySchema);
