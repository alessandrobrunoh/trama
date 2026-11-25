import { dayOf } from '../milestones/milestone-model';
import { roadmapRange } from './project-roadmap';
import { projectTargetDay } from './project-burnup-model';

describe('roadmapRange', () => {
  it('spans the whole months around the dates', () => {
    const r = roadmapRange([dayOf(new Date(2026, 10, 25)), dayOf(new Date(2026, 11, 12)), dayOf(new Date(2027, 0, 20))]);
    expect(r.months).toEqual([dayOf(new Date(2026, 10, 1)), dayOf(new Date(2026, 11, 1)), dayOf(new Date(2027, 0, 1))]);
    expect(r.from).toBe(dayOf(new Date(2026, 10, 1)));
    expect(r.to).toBe(dayOf(new Date(2027, 1, 1)));
  });

  it('is one month when the dates share it', () => {
    const r = roadmapRange([dayOf(new Date(2026, 10, 3)), dayOf(new Date(2026, 10, 25))]);
    expect(r.months).toHaveLength(1);
    expect(r.to - r.from).toBe(30);
  });
});

describe('projectTargetDay', () => {
  const ms = [{ targetDate: new Date(2026, 11, 12, 12).toISOString() }, { targetDate: new Date(2027, 0, 20, 12).toISOString() }, {}];

  it('prefers the project target', () => {
    expect(projectTargetDay({ targetDate: new Date(2027, 2, 1, 12).toISOString() }, ms)).toBe(dayOf(new Date(2027, 2, 1)));
  });

  it('falls back to the last milestone, or nothing', () => {
    expect(projectTargetDay({}, ms)).toBe(dayOf(new Date(2027, 0, 20)));
    expect(projectTargetDay({}, [{}])).toBeNull();
  });
});
