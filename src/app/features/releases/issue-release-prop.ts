// The release property of the issue page: one upcoming (or completed) release, grouped by pipeline.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideRocket } from '@lucide/angular';
import { TramaStore, type Issue, type Release } from '../../core';
import { PropertyRow } from '../../shared/property-row';
import { Picker, type PickOption } from '../../shared/picker';
import { RELEASE_STATUS_META, sortReleases } from './release-model';

@Component({
  selector: 'app-issue-release-prop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PropertyRow, Picker],
  host: { class: 'contents' },
  template: `
    <app-property-row label="Release" [icon]="rocket">
      <app-picker
        variant="field"
        label="Release"
        placeholder="No release"
        [clearable]="true"
        clearLabel="Remove from release"
        [searchable]="options().length > 6"
        [disabled]="!canEdit()"
        [options]="options()"
        [value]="selected()"
        (valueChange)="change($event)"
      />
    </app-property-row>
  `,
})
export class IssueReleaseProp {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();
  protected readonly rocket = LucideRocket;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly options = computed<PickOption[]>(() => {
    const currentId = this.issue().releaseId;
    const seen = new Set<string>();
    const out: PickOption[] = [];
    const pipelines = this.store
      .releasePipelines()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const pipeline of pipelines) {
      for (const release of sortReleases(this.store.releasesByPipeline().get(pipeline.id) ?? [])) {
        seen.add(release.id);
        out.push(releaseOption(release, pipeline.name));
      }
    }
    if (currentId && !seen.has(currentId)) {
      const release = this.store.getRelease(currentId);
      if (release) {
        const name = this.store.getReleasePipeline(release.pipelineId)?.name ?? 'Release';
        out.push(releaseOption(release, name));
      }
    }
    return out;
  });
  protected readonly selected = computed(() => {
    const id = this.issue().releaseId;
    return id ? [id] : [];
  });

  protected change(next: string[]): void {
    const releaseId = next[0] ?? null;
    if ((this.issue().releaseId ?? null) === releaseId) return;
    void this.store.setIssueRelease(this.issue().id, releaseId);
  }
}

function releaseOption(release: Release, pipelineName: string): PickOption {
  const status = RELEASE_STATUS_META[release.status];
  return {
    value: release.id,
    label: release.name,
    hint: status.label,
    group: pipelineName,
    search: `${pipelineName} ${release.name} ${status.label}`,
  };
}
