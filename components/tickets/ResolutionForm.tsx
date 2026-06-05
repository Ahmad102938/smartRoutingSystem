'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Part {
  name: string;
  quantity: number;
  cost?: number;
}

interface ResolutionFormProps {
  ticketId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResolved?: () => void;
}

export default function ResolutionForm({ ticketId, open, onOpenChange, onResolved }: ResolutionFormProps) {
  const { toast } = useToast();
  const [resolutionMinutes, setResolutionMinutes] = useState<number | ''>('');
  const [firstTimeFix, setFirstTimeFix] = useState(true);
  const [rootCause, setRootCause] = useState('');
  const [notes, setNotes] = useState('');
  const [parts, setParts] = useState<Part[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPart = () => setParts([...parts, { name: '', quantity: 1 }]);
  const removePart = (i: number) => setParts(parts.filter((_, idx) => idx !== i));
  const updatePart = (i: number, patch: Partial<Part>) => {
    setParts(parts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };

  const reset = () => {
    setResolutionMinutes('');
    setFirstTimeFix(true);
    setRootCause('');
    setNotes('');
    setParts([]);
    setError(null);
  };

  const submit = async () => {
    setError(null);

    if (typeof resolutionMinutes !== 'number' || resolutionMinutes <= 0) {
      setError('Resolution time must be a positive number of minutes.');
      return;
    }
    if (rootCause.trim().length < 3) {
      setError('Root cause must be at least 3 characters.');
      return;
    }
    if (notes.trim().length < 1) {
      setError('Technician notes are required.');
      return;
    }

    const cleanParts = parts
      .filter(p => p.name.trim().length > 0 && p.quantity > 0)
      .map(p => ({ name: p.name.trim(), quantity: p.quantity, cost: p.cost }));

    setSubmitting(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolution_time_minutes: resolutionMinutes,
          first_time_fix: firstTimeFix,
          root_cause: rootCause.trim(),
          technician_notes: notes.trim(),
          parts_used: cleanParts.length > 0 ? cleanParts : undefined
        })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }

      toast({ title: 'Ticket resolved', description: 'Awaiting moderator verification.' });
      reset();
      onOpenChange(false);
      onResolved?.();
    } catch (e: any) {
      setError(e.message ?? 'Failed to submit resolution');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resolve ticket</DialogTitle>
          <DialogDescription>
            Submit resolution details. The moderator will verify before the ticket closes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="resolution-time">Resolution time (minutes)</Label>
            <Input
              id="resolution-time"
              type="number"
              min={1}
              value={resolutionMinutes}
              onChange={e => setResolutionMinutes(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="e.g. 45"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="first-time-fix"
              checked={firstTimeFix}
              onCheckedChange={checked => setFirstTimeFix(checked === true)}
            />
            <Label htmlFor="first-time-fix" className="cursor-pointer">
              Fixed on first visit (no return trips needed)
            </Label>
          </div>

          <div>
            <Label htmlFor="root-cause">Root cause</Label>
            <Input
              id="root-cause"
              value={rootCause}
              onChange={e => setRootCause(e.target.value)}
              placeholder="e.g. Compressor relay failure"
              maxLength={500}
            />
          </div>

          <div>
            <Label htmlFor="notes">Technician notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="What did you find? What did you do?"
              rows={4}
              maxLength={5000}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Parts used (optional)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addPart}>
                <Plus className="h-4 w-4 mr-1" /> Add part
              </Button>
            </div>
            {parts.length > 0 && (
              <div className="space-y-2">
                {parts.map((p, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_100px_auto] gap-2 items-center">
                    <Input
                      placeholder="Part name"
                      value={p.name}
                      onChange={e => updatePart(i, { name: e.target.value })}
                    />
                    <Input
                      type="number"
                      min={1}
                      placeholder="Qty"
                      value={p.quantity}
                      onChange={e => updatePart(i, { quantity: Number(e.target.value) })}
                    />
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Cost"
                      value={p.cost ?? ''}
                      onChange={e => updatePart(i, { cost: e.target.value === '' ? undefined : Number(e.target.value) })}
                    />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removePart(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Submit resolution
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
