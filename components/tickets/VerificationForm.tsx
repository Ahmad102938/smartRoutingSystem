'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const GOOD_TAGS = ['fixed-fast', 'professional', 'clean-work', 'on-time'];
const BAD_TAGS = ['not-fixed', 'had-to-call-back', 'slow', 'unprofessional', 'damaged-property'];

interface VerificationFormProps {
  ticketId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified?: (verdict: 'GOOD' | 'BAD') => void;
}

export default function VerificationForm({ ticketId, open, onOpenChange, onVerified }: VerificationFormProps) {
  const { toast } = useToast();
  const [verdict, setVerdict] = useState<'GOOD' | 'BAD' | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleTag = (tag: string) => {
    setTags(tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]);
  };

  const reset = () => {
    setVerdict(null);
    setTags([]);
    setComment('');
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!verdict) {
      setError('Pick a verdict before submitting.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, tags, comment: comment.trim() || undefined })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }

      toast({
        title: verdict === 'GOOD' ? 'Ticket closed' : 'Ticket reopened',
        description:
          verdict === 'GOOD'
            ? 'Marked as resolved successfully.'
            : 'Sent back to technician for rework.'
      });
      reset();
      onOpenChange(false);
      onVerified?.(verdict);
    } catch (e: any) {
      setError(e.message ?? 'Failed to submit verification');
    } finally {
      setSubmitting(false);
    }
  };

  const tagOptions = verdict === 'GOOD' ? GOOD_TAGS : verdict === 'BAD' ? BAD_TAGS : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Verify resolution</DialogTitle>
          <DialogDescription>
            Was the issue actually fixed? Your answer trains the routing model.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={verdict === 'GOOD' ? 'default' : 'outline'}
              onClick={() => {
                setVerdict('GOOD');
                setTags([]);
              }}
              className="h-auto py-4 flex flex-col gap-1"
            >
              <ThumbsUp className="h-6 w-6" />
              <span>Fixed</span>
            </Button>
            <Button
              type="button"
              variant={verdict === 'BAD' ? 'destructive' : 'outline'}
              onClick={() => {
                setVerdict('BAD');
                setTags([]);
              }}
              className="h-auto py-4 flex flex-col gap-1"
            >
              <ThumbsDown className="h-6 w-6" />
              <span>Not fixed</span>
            </Button>
          </div>

          {tagOptions.length > 0 && (
            <div>
              <Label className="text-sm">Tags (optional)</Label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {tagOptions.map(tag => (
                  <Badge
                    key={tag}
                    variant={tags.includes(tag) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="verify-comment">Comment (optional)</Label>
            <Textarea
              id="verify-comment"
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={
                verdict === 'BAD'
                  ? 'What still needs attention?'
                  : 'Anything worth noting for next time?'
              }
            />
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
          <Button onClick={submit} disabled={submitting || !verdict}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
