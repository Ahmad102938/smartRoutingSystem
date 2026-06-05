'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Plus, Trash2, Save } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

type Proficiency = 'NOVICE' | 'COMPETENT' | 'EXPERT';

interface Skill {
  id?: string;
  skill: string;
  proficiency: Proficiency;
  years_experience?: number;
}

const SUGGESTED_SKILLS = [
  'Refrigeration',
  'HVAC',
  'Electrical',
  'Plumbing',
  'POS Systems',
  'Network',
  'IT Support',
  'Computer Repair',
  'General Maintenance'
];

interface SkillEditorProps {
  userId: string;
  /** When true, hides the suggested-skills row (for read-only or compact contexts). */
  compact?: boolean;
}

export default function SkillEditor({ userId, compact = false }: SkillEditorProps) {
  const { toast } = useToast();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/technicians/${userId}/skills`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data: Skill[] = await res.json();
        if (!cancelled) {
          setSkills(data);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message ?? 'Failed to load skills');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const addSkill = (name?: string) => {
    setSkills([...skills, { skill: name ?? '', proficiency: 'COMPETENT' }]);
    setDirty(true);
  };

  const removeSkill = (i: number) => {
    setSkills(skills.filter((_, idx) => idx !== i));
    setDirty(true);
  };

  const updateSkill = (i: number, patch: Partial<Skill>) => {
    setSkills(skills.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setDirty(true);
  };

  const save = async () => {
    setError(null);

    const seen = new Set<string>();
    for (const s of skills) {
      const name = s.skill.trim();
      if (name.length === 0) {
        setError('All skills must have a name.');
        return;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        setError(`Duplicate skill: "${name}".`);
        return;
      }
      seen.add(key);
    }

    setSaving(true);
    try {
      const payload = {
        skills: skills.map(s => ({
          skill: s.skill.trim(),
          proficiency: s.proficiency,
          years_experience: s.years_experience
        }))
      };
      const res = await fetch(`/api/technicians/${userId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }
      const updated: Skill[] = await res.json();
      setSkills(updated);
      setDirty(false);
      toast({ title: 'Skills saved' });
    } catch (e: any) {
      setError(e.message ?? 'Failed to save skills');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading skills…
      </div>
    );
  }

  const existingNames = new Set(skills.map(s => s.skill.trim().toLowerCase()));
  const remainingSuggestions = SUGGESTED_SKILLS.filter(s => !existingNames.has(s.toLowerCase()));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Technician skills</CardTitle>
        <CardDescription>
          These drive routing matches. Be honest about proficiency — the model uses it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!compact && remainingSuggestions.length > 0 && (
          <div>
            <Label className="text-xs text-muted-foreground">Quick add</Label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {remainingSuggestions.map(s => (
                <Badge
                  key={s}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => addSkill(s)}
                >
                  + {s}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No skills yet — add one to be considered for matching tickets.</p>
          ) : (
            skills.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_140px_100px_auto] gap-2 items-center">
                <Input
                  placeholder="Skill name"
                  value={s.skill}
                  onChange={e => updateSkill(i, { skill: e.target.value })}
                />
                <Select
                  value={s.proficiency}
                  onValueChange={value => updateSkill(i, { proficiency: value as Proficiency })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NOVICE">Novice</SelectItem>
                    <SelectItem value="COMPETENT">Competent</SelectItem>
                    <SelectItem value="EXPERT">Expert</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  placeholder="Years"
                  value={s.years_experience ?? ''}
                  onChange={e =>
                    updateSkill(i, {
                      years_experience: e.target.value === '' ? undefined : Number(e.target.value)
                    })
                  }
                />
                <Button type="button" variant="ghost" size="icon" onClick={() => removeSkill(i)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button type="button" variant="outline" onClick={() => addSkill()}>
            <Plus className="h-4 w-4 mr-1" /> Add custom skill
          </Button>
          <Button type="button" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save changes
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
