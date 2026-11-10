"""Real old-personal reads and merged discovery retain current organization authority."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import sys
import tempfile
import time
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"lib"))
from studio_accounts import AccountStore
from studio_account_runtime import ensure_binding,drop_to_worker,trusted_runtime
from studio_account_sessions import supervise
from studio_organization import OrganizationStore,publish_worker_marker
from studio_organization_channel import OrganizationChannel,CHANNEL_ENV
from account_fixture_cleanup import cleanup_worker_accounts

@unittest.skipUnless(os.geteuid()==0 and os.environ.get("KCODER_TEST_SYSTEM_USERS")=="1" and os.environ.get("KCODER_ORGANIZATION_APP_SERVER") and os.environ.get("KCODER_ORGANIZATION_LEGACY_FIXTURE"),"Explicit owned system-user and both current fixture executables required")
class OrganizationLegacyPublicationTests(unittest.TestCase):
    def test_existing_personal_body_keeps_original_owner_and_current_supervisor_acl(self):
        with ExitStack() as resources:
            installed=Path(resources.enter_context(tempfile.TemporaryDirectory(prefix="kcoder-org-legacy-code-",dir="/usr/local/lib")));installed.chmod(0o755)
            programs=[]
            for name,variable in [("kcoder","KCODER_ORGANIZATION_APP_SERVER"),("seed","KCODER_ORGANIZATION_LEGACY_FIXTURE")]:
                destination=installed/name;shutil.copyfile(os.environ[variable],destination);destination.chmod(0o755);programs.append(trusted_runtime(destination))
            root=Path(resources.enter_context(tempfile.TemporaryDirectory(prefix="kcoder-org-legacy-")));root.chmod(0o711)
            accounts=AccountStore(root/"accounts");resources.callback(cleanup_worker_accounts,accounts)
            accounts.create("legacy-member","synthetic-legacy-password","admin");other=accounts.create("policy-owner","synthetic-other-password")
            actor=accounts.authenticate("legacy-member","synthetic-legacy-password");binding=ensure_binding(accounts,actor,root/"homes");home=Path(binding["home"]);settings=home/".config/kcoder/settings.json"
            settings.write_text(json.dumps({"active_provider":"fixture","providers":{"fixture":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:1/v1","default_model":"no-model","context_window_tokens":8192,"output_headroom_tokens":1024,"max_output_tokens":1024}},"knowledge":{"enabled":True},"integrations":{"knowledge":{"publications_enabled":True}},"memory":{"observer_mode":"disabled","structured_enabled":False},"session_memory":{"enabled":False}}));settings.chmod(0o600)
            def start_session(current,governed=False):
                command_read,command_write=os.pipe();output_read,output_write=os.pipe();error_path=root/("governed.log" if governed else "personal.log");error_fd=os.open(error_path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
                supervisor=os.fork()
                if supervisor==0:
                    os.close(command_write);os.close(output_read);channel=OrganizationChannel(accounts,current) if governed else None
                    def execute():
                        os.dup2(command_read,0);os.dup2(output_write,1);os.dup2(error_fd,2);environment=drop_to_worker(binding,current)
                        if channel:environment[CHANNEL_ENV]=str(channel.child_fd())
                        os.execve(programs[0],[programs[0],"--cwd",str(home/"workspace"),"--settings-file",str(settings),"app-server"],environment)
                    code=supervise(accounts,current,execute,interval=0.01,policy_channel=channel);os._exit(code)
                os.close(command_read);os.close(output_write);os.close(error_fd);buffer=bytearray();sequence=0;stopped=False
                def stop():
                    nonlocal stopped
                    if stopped:return
                    stopped=True;os.close(command_write);deadline=time.monotonic()+10
                    while time.monotonic()<deadline:
                        done,_=os.waitpid(supervisor,os.WNOHANG)
                        if done:break
                        time.sleep(0.02)
                    else:os.kill(supervisor,signal.SIGTERM);os.waitpid(supervisor,0)
                    os.close(output_read)
                resources.callback(stop)
                def rpc(method,params):
                    nonlocal sequence
                    sequence+=1;os.write(command_write,(json.dumps({"id":sequence,"method":method,"params":params})+"\n").encode());deadline=time.monotonic()+15
                    while time.monotonic()<deadline:
                        while b"\n" in buffer:
                            line,_,remaining=buffer.partition(b"\n");buffer[:]=remaining;response=json.loads(line)
                            if response.get("id")==sequence:
                                self.assertNotIn("error",response,response);return response["result"]
                        if select.select([output_read],[],[],max(0,deadline-time.monotonic()))[0]:
                            chunk=os.read(output_read,65536);self.assertTrue(chunk,error_path.read_text());buffer.extend(chunk)
                    self.fail("Owned native RPC timeout: "+error_path.read_text())
                rpc("initialize",{"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-legacy-read","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":True,"knowledgePublicationsV1":True}}})
                return rpc,stop
            rpc,stop=start_session(actor);personal_scope=rpc("integrations/scope/read",{});self.assertIsNone(personal_scope.get("organizationId"))
            output_read,output_write=os.pipe();seed=os.fork()
            if seed==0:
                os.close(output_read);os.dup2(output_write,1);environment=drop_to_worker(binding,actor);environment["KCODER_TEST_ORGANIZATION_LEGACY_FIXTURE"]="1";os.execve(programs[1],[programs[1]],environment)
            os.close(output_write);raw=b""
            while True:
                chunk=os.read(output_read,65536)
                if not chunk:break
                raw+=chunk
            os.close(output_read);_,status=os.waitpid(seed,0);self.assertEqual(os.waitstatus_to_exitcode(status),0);source=json.loads(raw);self.assertEqual(source["actualUid"],binding["uid"])
            def call(rpc,scope,method,payload,mutation=False,revision=None):
                request={"contractVersion":"parallel-v1","requestId":str(uuid.uuid4()),"scope":scope,"timeoutMs":10000,"payload":payload}
                if mutation:request["operationId"]=str(uuid.uuid4())
                if revision is not None:request["expectedRevision"]=str(revision)
                return rpc("integrations/knowledge/"+method,request)
            published=call(rpc,personal_scope,"publishKnowledge",{"draft":{"publicationId":"owned-old-publication","title":"Owned old personal body","purpose":"Isolated current-authority legacy fixture","reviewConclusion":None,"visibility":"personal","audienceId":None,"sources":[source["source"]],"validFromMs":None,"validUntilMs":None,"unresolved":[]}},True,0);self.assertEqual(published["status"],"completed",published);publication=published["result"]["publication"];old_owner=publication["owner"]
            extra_ids=["owned-old-extra-"+str(index) for index in range(10)]
            for identity in extra_ids:
                extra=call(rpc,personal_scope,"publishKnowledge",{"draft":{**publication["draft"],"publicationId":identity}},True,0)
                self.assertEqual(extra["status"],"completed",extra)
            old_spaces=[path for path in settings.parent.iterdir() if path.is_dir() and (path/"catalog-binding.json").exists()];self.assertEqual(len(old_spaces),1)
            legacy_space=old_spaces[0];old_binding=(legacy_space/"catalog-binding.json").read_bytes();old_identity=(legacy_space.stat().st_dev,legacy_space.stat().st_ino,(legacy_space/"catalog.sqlite").stat().st_ino)
            stop()
            policy=OrganizationStore(accounts);policy.configure("owned-legacy-org")
            for account in [actor,other]:policy.administer(None,{"operation":"organization.member","principalId":account["id"],"roles":["member"]})
            actor=accounts.authenticate("legacy-member","synthetic-legacy-password");publish_worker_marker(binding,actor["id"],"owned-legacy-org")
            rpc,stop=start_session(actor,True);scope=rpc("integrations/scope/read",{});self.assertEqual(scope["organizationId"],"owned-legacy-org")
            for field in ["accountId","targetId","workspaceId"]:self.assertEqual(scope[field],personal_scope[field])
            read_payload={"owner":old_owner,"publicationId":"owned-old-publication","version":1}
            def read():return call(rpc,scope,"resolvePublication",read_payload)
            self.assertNotEqual(read()["status"],"completed","administrator role alone cannot reveal the old body")
            def key(kind,owner,identity):return "knowledge:"+hashlib.sha256(json.dumps(["native-knowledge-resource-v1",kind,owner["accountId"],owner["targetId"],owner.get("workspaceId"),owner.get("organizationId"),identity],ensure_ascii=False,separators=(",",":")).encode()).hexdigest()
            current_owner={name:scope[name] for name in ["accountId","targetId","workspaceId","organizationId"]}
            resource_ids=[key("knowledge",current_owner,"current-target"),key("publication",old_owner,"owned-old-publication")]
            def grant(allowed):
                for resource_id in resource_ids:policy.administer(None,{"operation":"organization.resource","expectedRevision":policy._load()["revision"],"resource":{"id":resource_id,"kind":"knowledge","owner":other["id"],"visibility":"organization","grants":[{"subject":actor["id"],"actions":["read"]}] if allowed else []}})
            grant(True)
            # Nine extra old versions are visible; the last old record has no read grant.
            for identity in extra_ids[:-1]:
                policy.administer(None,{"operation":"organization.resource","expectedRevision":policy._load()["revision"],"resource":{"id":key("publication",old_owner,identity),"kind":"knowledge","owner":other["id"],"visibility":"organization","grants":[{"subject":actor["id"],"actions":["read"]}]}})
            new_id="owned-old-publication"
            new_key=key("publication",current_owner,new_id)
            for resource_id in [resource_ids[0],new_key]:policy.administer(None,{"operation":"organization.resource","expectedRevision":policy._load()["revision"],"resource":{"id":resource_id,"kind":"knowledge","owner":other["id"],"visibility":"organization","grants":[{"subject":actor["id"],"actions":["read","write","publish"]}]}})
            new_draft={**publication["draft"],"publicationId":new_id}
            new=call(rpc,scope,"publishKnowledge",{"draft":new_draft},True,0);self.assertEqual(new["status"],"completed",new);self.assertEqual(new["result"]["publication"]["owner"]["organizationId"],"owned-legacy-org")
            allowed=read();self.assertEqual(allowed["status"],"completed",allowed);loaded=allowed["result"]["publication"];self.assertEqual(loaded["owner"],old_owner);self.assertEqual(hashlib.sha256(loaded["pages"][0]["markdown"].encode()).hexdigest(),source["markdownSha256"])
            citation=call(rpc,scope,"readCitation",{**read_payload,"source":source["source"]});self.assertEqual(citation["status"],"completed",citation)
            source_states=call(rpc,scope,"readPublicationSources",read_payload);self.assertEqual(source_states["status"],"completed",source_states)
            def listing(after=None):return call(rpc,scope,"listPublications",{"after":after})
            def completed_page(reply):
                self.assertEqual(reply["status"],"completed",reply)
                return reply["result"]["page"]
            first=completed_page(listing());self.assertEqual(len(first["items"]),10);self.assertIsNotNone(first["nextCursor"])
            second=completed_page(listing(first["nextCursor"]));self.assertEqual(len(second["items"]),1);self.assertIsNone(second["nextCursor"])
            filter_changed=call(rpc,scope,"listPublications",{"after":first["nextCursor"],"includeCandidates":False});self.assertNotEqual(filter_changed["status"],"completed");self.assertIsNone(filter_changed.get("result"));self.assertEqual(filter_changed["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            merged=first["items"]+second["items"]
            identities=[(item["owner"].get("organizationId"),item["draft"]["publicationId"]) for item in merged]
            self.assertEqual(len(set(identities)),11);self.assertIn((None,new_id),identities);self.assertIn(("owned-legacy-org",new_id),identities)
            self.assertNotIn(extra_ids[-1],json.dumps(merged))
            current_space=next(path for path in settings.parent.iterdir() if path.is_dir() and path!=legacy_space and (path/"catalog-binding.json").exists())
            moved=current_space.with_name("owned-missing-current-"+uuid.uuid4().hex)
            current_space.rename(moved)
            try:
                missing=listing(first["nextCursor"]);self.assertNotEqual(missing["status"],"completed");self.assertIsNone(missing.get("result"));self.assertEqual(missing["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
                unavailable=listing();self.assertEqual(unavailable["status"],"unavailable");self.assertIsNone(unavailable.get("result"));self.assertEqual(unavailable["error"]["recovery"],"retry_read")
            finally:moved.rename(current_space)
            repeat=completed_page(listing());self.assertEqual([item["owner"] for item in repeat["items"]],[item["owner"] for item in first["items"]]);self.assertEqual(repeat["nextCursor"],first["nextCursor"])
            updated=call(rpc,scope,"publishKnowledge",{"draft":new_draft},True,1);self.assertEqual(updated["status"],"completed",updated)
            changed=listing(first["nextCursor"]);self.assertNotEqual(changed["status"],"completed");self.assertIsNone(changed.get("result"));self.assertEqual(changed["error"]["code"],"KNOWLEDGE_INVALID_CURSOR");self.assertEqual(changed["error"]["recovery"],"retry_read")
            refreshed=completed_page(listing());self.assertEqual(len(refreshed["items"]),10)
            policy.administer(None,{"operation":"organization.resource","expectedRevision":policy._load()["revision"],"resource":{"id":key("publication",old_owner,"owned-old-publication"),"kind":"knowledge","owner":other["id"],"visibility":"organization","grants":[]}})
            stale=listing(refreshed["nextCursor"]);self.assertNotEqual(stale["status"],"completed");self.assertIsNone(stale.get("result"));self.assertEqual(stale["error"]["code"],"KNOWLEDGE_INVALID_CURSOR")
            filtered=completed_page(listing());self.assertEqual(len(filtered["items"]),10);self.assertIsNone(filtered["nextCursor"])
            self.assertNotIn((None,"owned-old-publication"),[(item["owner"].get("organizationId"),item["draft"]["publicationId"]) for item in filtered["items"]])
            self.assertNotEqual(read()["status"],"completed")
            self.assertEqual((legacy_space/"catalog-binding.json").read_bytes(),old_binding)
            self.assertEqual((legacy_space.stat().st_dev,legacy_space.stat().st_ino,(legacy_space/"catalog.sqlite").stat().st_ino),old_identity)
            self.assertEqual(len([path for path in settings.parent.iterdir() if path.is_dir() and (path/"catalog-binding.json").exists()]),2)
            wrong=call(rpc,scope,"resolvePublication",{**read_payload,"owner":{**old_owner,"accountId":"another-profile"}});self.assertNotEqual(wrong["status"],"completed")
            grant(False);denied=read();self.assertNotEqual(denied["status"],"completed");self.assertIsNone(denied.get("result"));forged=call(rpc,{**scope,"organizationId":None},"resolvePublication",read_payload);self.assertNotEqual(forged["status"],"completed");stop()
            print(json.dumps({"legacyNativeEvidence":{"actualUid":binding["uid"],"currentOrganization":scope["organizationId"],"oldOwnerPreserved":True,"oldDirectoryDatabaseAndBindingPreserved":True,"currentNamespaceAlsoExists":True,"resolveCitationAndSourceMetadataPassed":True,"mergedDirectoryAllowedItems":11,"mergedPages":[10,1],"hiddenItemAbsent":True,"sameIdDifferentOwnersPreserved":True,"sourceMutationInvalidatesCursor":True,"missingSourceInvalidatesCursorAndNeverBecomesEmpty":True,"filterChangeInvalidatesCursor":True,"policyRevocationInvalidatesCursor":True,"revokedItemFilteredWithoutCountLeak":True,"administratorDefaultDenied":True,"sameConnectionGrantThenRevocationDenied":True,"forgedPersonalScopeAndForeignOwnerDenied":True,"modelCalls":0}}))
