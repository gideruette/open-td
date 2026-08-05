import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('shows the match setup screen by default', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Open TD');
    expect(compiled.querySelectorAll('.match-slot').length).toBe(2);
  });

  it('shows the map selection screen with 5 maps once slots are chosen', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    (fixture.componentInstance as unknown as { onSlotsChosen(slots: unknown): void }).onSlotsChosen({
      attack: 'human',
      defense: 'human',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelectorAll('.map-card').length).toBe(5);
  });
});
