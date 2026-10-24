'use strict';

const MARKER='REAL SUBJECT IDENTITY';
const POLICY=`IDENTITY LAYER - ${MARKER} (new title and script take priority):
Determine the central subjects from the NEW title and script, never from the reference's face.
If the video is meaningfully about a named real person, show that actual recognizable person
and explicitly write their unambiguous full name in every variant's image_prompt. A generic
anonymous stand-in, invented presenter, similar-looking stranger or unnamed "racing driver"
is NOT an acceptable substitute. Keep the same required person across different hooks/angles.
Examples only, not default subjects: a Walter R\u00f6hrl video must name Walter R\u00f6hrl; a Michael
Schumacher video must name Michael Schumacher; a Niki Lauda video must name Niki Lauda.
This applies equally to other named people. Resolve abbreviated names from the new script;
do not confuse Michael with Ralf or Mick Schumacher, or guess a first name from the reference.
An incidental mention does not make someone the video's subject. If identity is ambiguous,
do not invent a full name or borrow the reference person's identity.

If the reference already shows the same real person required by the NEW video, retain that
identity. Do NOT demand a different face, build or age merely to look different. Specify a
recognizable, faithful depiction and script-supported era/appearance without inventing a
historical event, documented meeting, injury or joint historical photograph. Comparisons can
use clearly editorial separate portraits, not a fabricated meeting.
For multiple central people, explicitly name each person actually depicted, distinguish them,
and use the appropriate existing subject positions; do not add unrelated heads or presenters.
For videos not about a named person, do not invent a celebrity or force a human into an
object-only concept. Preserve a channel host only when the NEW video's supplied context
explicitly establishes that host; a reference-channel presenter is not the new channel host.

Inherit the reference's layout, subject placement, text architecture, palette and lighting.
Replace unrelated people and scene details with content supported by the NEW video. Reuse a
reference identity ONLY when that same identity is required by the new title/script. Replace
unrelated locations, props and signage while retaining their compositional roles. The subject
identity rules take precedence over generic instructions to make every person look different.`;

function replaceOnce(text,before,after){
  if(text.split(before).length!==2)throw Error('Thumbnail identity template fingerprint changed');
  return text.replace(before,after);
}

function updateWriterPrompt(prompt){
  if(typeof prompt!=='string')throw Error('Thumbnail identity template must be a string');
  if(prompt.includes(MARKER))return prompt;
  const start=prompt.indexOf('IDENTITY LAYER (must be visibly DIFFERENT');
  const end=prompt.indexOf('\n\nPHYSICAL SCALE LAYER',start);
  if(start<0||end<0)throw Error('Thumbnail identity template fingerprint changed');
  let output=prompt.slice(0,start)+POLICY+prompt.slice(end);
  const exampleStart=output.indexOf('identity-layer element (e.g.');
  const exampleEnd=output.indexOf('Never write',exampleStart);
  if(exampleStart<0||exampleEnd<0)throw Error('Thumbnail identity editor template changed');
  output=output.slice(0,exampleStart)+'identity-layer element, naming the actual subject from the NEW video in full and explicitly\nreplacing any unrelated reference presenter. '+output.slice(exampleEnd);
  output=replaceOnce(output,'while STILL replacing every identity-layer element as required above.',
    'while applying the real-subject identity rules above.');
  if(prompt.includes('Return 8-12 moments and exactly ')&&prompt.includes('"core_promise"')){
    output=replaceOnce(output,
      'Inherit the reference\'s layout, subject placement, text architecture, palette and lighting.',
      'Respect the native variant rules: variant 1 inherits the reference layout; other variants\ninherit its style and retain the distinct composition required by their own script moment.');
    output=replaceOnce(output,
      "an explicit, named replacement for EVERY entry in the blueprint's scene_identity_elements that is in frame",
      "an explicit identity decision for EVERY entry in the blueprint's scene_identity_elements that is in frame, keeping a reference person only if the NEW video requires that person");
    return replaceOnce(output,'that no identity-layer element from the reference is carried over recognizably',
      'that no unrelated identity-layer element from the reference is carried over recognizably');
  }
  output=replaceOnce(output,'with the identity layer fully replaced (a different\nperson, a different environment, different secondary props)',
    'with the correct named subjects from the NEW video, a new environment and appropriate\nsecondary props');
  output=replaceOnce(output,'Give each variant a different subject or angle',
    'Give each variant a different scene or angle while preserving required subject identities');
  output=replaceOnce(output,"an explicit, named replacement for EVERY entry in the blueprint's\nscene_identity_elements",
    "an explicit identity decision for EVERY entry in the blueprint's\nscene_identity_elements, keeping a reference person only if the NEW video requires that person");
  output=replaceOnce(output,'that no identity-layer element from the\nreference is carried over recognizably',
    'that no unrelated identity-layer element from the\nreference is carried over recognizably');
  return output;
}

const RETENTION=`\n\nNAMED-SUBJECT RETENTION:
Preserve the same required people and their unambiguous full names from the original prompt.
Do not anonymize, substitute a generic stand-in or change a person's identity merely to create
variation. Keep relevant era/appearance and any supplied channel-host identity intact. Respect
provider moderation; do not conceal identity or bypass a refusal. Keep the native output format.
This is prompt preservation, not a face-recognition or biometric identity-verification task.`;
const updateRewritePrompt=prompt=>typeof prompt==='string'&&prompt.includes('NAMED-SUBJECT RETENTION:')?prompt:prompt+RETENTION;
const updateValidationPrompt=updateRewritePrompt;

function validateTemplates({writer,rewrite,validator}){
  for(const count of [1,2,3,4])updateWriterPrompt(writer({language:'English',count}));
  if(!String(rewrite({runIndex:1,promptToRewrite:'subject'})).includes('Prompt to update SFW:')
    ||!String(validator({originalPrompt:'subject'})).includes('Rules for the corrected prompt:'))
    throw Error('Thumbnail correction template fingerprint changed');
  return true;
}

function createThumbnailSubjectHooks({enabled=true,onError=()=>{}}={}){
  const wrap=(original,transform,kind)=>{
    if(!enabled||original.vfThumbnailSubjectIdentity)return original;
    let reported=false;
    function build(...args){
      const prompt=original.apply(this,args);
      try{return transform(prompt);}catch(error){
        if(!reported){reported=true;try{onError(kind,String(error?.message||error));}catch{}}
        return prompt;
      }
    }
    Object.defineProperty(build,'vfThumbnailSubjectIdentity',{value:true});
    return build;
  };
  return {wrapWriter:fn=>wrap(fn,updateWriterPrompt,'writer'),
    wrapRewrite:fn=>wrap(fn,updateRewritePrompt,'rewrite'),
    wrapValidator:fn=>wrap(fn,updateValidationPrompt,'validator')};
}
module.exports={updateWriterPrompt,updateRewritePrompt,updateValidationPrompt,validateTemplates,createThumbnailSubjectHooks};
